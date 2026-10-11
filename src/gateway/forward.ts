import { once } from "node:events";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { routingHeaders, type WireProtocol } from "../acp/systems.js";
import { faultBody, faultStatus } from "./faults.js";
import { SHAPES } from "./shape/index.js";
import { encodeSse, sseDecoder } from "./sse.js";
import { translatorFor } from "./translate/index.js";
import type { Translator } from "./translate/types.js";
import type { GatewayDeps, GatewayFault, GrantSpec, UpstreamResponse } from "./types.js";

export type RequestKind = "infer" | "count";

/** What each protocol's client appends to the address it was given. An Anthropic base carries no version segment; the OpenAI ones do. */
const UPSTREAM_PATH: Record<WireProtocol, Record<RequestKind, string | null>> = {
  "anthropic-messages": { infer: "/v1/messages", count: "/v1/messages/count_tokens" },
  "openai-responses": { infer: "/responses", count: null },
  "openai-chat": { infer: "/chat/completions", count: null },
};

/** Copied from the harness's request and nothing else is: its credential headers, session ids and installation ids stop here. */
const PASSED_REQUEST_HEADERS = ["content-type", "accept", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta"];
const PASSED_RESPONSE_HEADERS = ["content-type", "retry-after"];

const MAX_REFUSAL_BYTES = 4096;
const MAX_QUOTED_CHARS = 200;
/** An answer that is not a stream is held whole to be translated; a turn's worth of text is kilobytes. */
const MAX_WHOLE_ANSWER_BYTES = 32 * 1024 * 1024;
/** Sent where a harness names no version and the endpoint requires one, which grok's Messages requests do not (Q6.127). */
const ANTHROPIC_VERSION = "2023-06-01";

export interface ForwardRequest {
  spec: GrantSpec;
  kind: RequestKind;
  /** The query string as the harness sent it, leading question mark included. */
  search: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export async function forward(request: ForwardRequest, res: ServerResponse, deps: GatewayDeps): Promise<void> {
  const { spec } = request;
  const refuse = (fault: GatewayFault): void => {
    spec.onFault?.(fault);
    const text = JSON.stringify(faultBody(spec.inbound, fault));
    res.writeHead(faultStatus(fault), { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const system = deps.machine().system(spec.system);
  if (system === null) {
    refuse({ code: "gateway_provider_gone", message: `This session's provider is no longer on this machine.`, retryable: false });
    return;
  }
  const path = UPSTREAM_PATH[spec.outbound.protocol][request.kind];
  if (path === null) {
    res.writeHead(404).end();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString("utf8")) as unknown;
  } catch {
    parsed = null;
  }
  const asked = (parsed as { model?: unknown } | null)?.model;
  if (spec.model !== null && asked !== spec.model) {
    const named = typeof asked === "string" && asked.length > 0 ? clip(asked) : "another model";
    refuse({
      code: "gateway_wrong_model",
      message: `This session runs on ${spec.model}; the agent asked ${system.displayName} for ${named}.`,
      retryable: false,
    });
    return;
  }


  const translator = spec.outbound.protocol === spec.inbound ? null : translatorFor(spec.inbound, spec.outbound.protocol);
  let body = request.body;
  const headers: Record<string, string> = {};
  if (spec.outbound.protocol === spec.inbound) {
    for (const name of PASSED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
  } else {
    // A translated request is this daemon's own: nothing the harness said about itself or its protocol describes it.
    const context = { model: spec.model ?? (typeof asked === "string" ? asked : "") };
    const out = translator === null ? { untranslatable: UNCARRIED } : translator.request(parsed, context);
    if ("untranslatable" in out) {
      refuse({ code: "gateway_untranslatable", message: out.untranslatable, retryable: false });
      return;
    }
    body = Buffer.from(JSON.stringify(out.body));
    headers["content-type"] = "application/json";
  }
  if (spec.outbound.protocol === "anthropic-messages" && headers["anthropic-version"] === undefined) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }

  const shape = system.signIn === null ? undefined : SHAPES[system.signIn];
  const wantsStream = (parsed as { stream?: unknown } | null)?.stream === true;
  if (shape !== undefined && request.kind === "infer") {
    // Such a system answers only as a stream, and nothing here assembles one into the whole answer a harness asked for.
    if (!wantsStream) {
      refuse({
        code: "gateway_untranslatable",
        message: `${system.displayName} answers only as a stream, and this agent asked for a whole answer.`,
        retryable: false,
      });
      return;
    }
    let outgoing: unknown;
    try {
      outgoing = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      outgoing = null;
    }
    const shaped = shape(outgoing);
    if ("untranslatable" in shaped) {
      refuse({ code: "gateway_untranslatable", message: shaped.untranslatable, retryable: false });
      return;
    }
    body = Buffer.from(JSON.stringify(shaped.body));
    headers["content-type"] = "application/json";
  }

  const abort = new AbortController();
  const hungUp = (): void => {
    if (!res.writableFinished) abort.abort();
  };
  res.on("close", hungUp);

  const secret = await deps.secretFor(spec.system, abort.signal);
  const signed = typeof secret === "string" ? routingHeaders(spec.system, secret, deps.machine()) : {};
  if (typeof secret !== "string" || Object.keys(signed).length === 0) {
    res.off("close", hungUp);
    refuse(
      typeof secret !== "string"
        ? secret
        : { code: "gateway_no_credential", message: `${system.displayName} names no way to sign a request.`, retryable: false },
    );
    return;
  }
  // Last, so nothing the harness sent can stand where the key goes.
  Object.assign(headers, signed);

  let upstream: UpstreamResponse;
  try {
    upstream = await deps.transport.send({
      // A query is the inbound protocol's own, and means nothing to another.
      url: `${spec.outbound.baseUrl}${path}${translator === null ? request.search : ""}`,
      headers,
      body,
      signal: abort.signal,
    });
  } catch {
    res.off("close", hungUp);
    if (abort.signal.aborted) return;
    refuse({
      code: "gateway_upstream_unreachable",
      message: `${system.displayName} could not be reached from this machine.`,
      retryable: true,
    });
    return;
  }

  // A plan's limit clears in hours, and a 429 is what every harness spends minutes retrying.
  const spent = system.signIn !== null && upstream.status === 429;
  if (upstream.status === 401 || upstream.status === 403 || spent) {
    const said = await refusalOf(upstream);
    res.off("close", hungUp);
    const held = system.signIn === null ? "the key saved on this machine" : "this machine's sign-in";
    refuse({
      code: spent ? "gateway_usage_limit" : "gateway_upstream_refused",
      message: spent
        ? `The ${system.displayName} plan signed in on this machine has reached a limit` + (said === null ? "." : `: ${said}`)
        : `${system.displayName} refused ${held}` + (said === null ? "." : `: ${said}`),
      retryable: false,
    });
    return;
  }

  if (translator !== null) {
    const context = { model: spec.model ?? (typeof asked === "string" ? asked : "") };
    await answerTranslated(translator, context, upstream, res, wantsStream);
    return;
  }

  const passed: Record<string, string> = {};
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = upstream.header(name);
    if (value !== null) passed[name] = value;
  }
  res.writeHead(upstream.status, passed);
  // At once: a harness waits on the first byte of a stream, and a model may think for a minute before the second.
  res.flushHeaders();
  if (upstream.body === null) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body as never), res);
  } catch {
    // A stream cut on either side ends as a cut: every harness measured retries one, and nothing here could finish the answer.
    res.destroy();
  }
}

const UNCARRIED = "This agent's requests cannot be carried to this provider.";

/** The provider's answer in the protocol the harness asked in: an error as that protocol's error, a stream event by event, anything else whole. */
async function answerTranslated(
  translator: Translator,
  context: { model: string },
  upstream: UpstreamResponse,
  res: ServerResponse,
  streamed: boolean,
): Promise<void> {
  const json = (status: number, value: unknown): void => {
    const text = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  if (upstream.status >= 400 || !streamed) {
    const raw = await wholeOf(upstream, MAX_WHOLE_ANSWER_BYTES);
    let value: unknown = null;
    try {
      value = raw === null ? null : (JSON.parse(raw) as unknown);
    } catch {
      value = null;
    }
    if (upstream.status >= 400) {
      const retry = upstream.header("retry-after");
      const text = JSON.stringify(translator.error(upstream.status, value));
      res.writeHead(upstream.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
        ...(retry === null ? {} : { "retry-after": retry }),
      });
      res.end(text);
      return;
    }
    const answer = translator.whole(upstream.status, value, context);
    // An answer the provider failed comes back in the error's shape, and a 200 around it would read as a reply.
    json((answer as { type?: unknown } | null)?.type === "error" ? 502 : 200, answer);
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.flushHeaders();
  const decoder = sseDecoder();
  const stream = translator.stream(context);
  let finished = false;
  const write = async (events: readonly { event: string | null; data: string }[]): Promise<void> => {
    for (const event of events) {
      if (event.event === "message_stop") finished = true;
      if (!res.write(encodeSse(event))) await once(res, "drain");
    }
  };
  try {
    if (upstream.body !== null) {
      for await (const chunk of Readable.fromWeb(upstream.body as never)) {
        for (const event of decoder.push(chunk as Uint8Array)) await write(stream.push(event));
      }
    }
    await write(stream.end());
  } catch {
    finished = false;
  }
  // An answer that never finished ends as a cut, never as a short reply: every harness measured retries a cut.
  if (finished) res.end();
  else res.destroy();
}

async function wholeOf(upstream: UpstreamResponse, limit: number): Promise<string | null> {
  if (upstream.body === null) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of Readable.fromWeb(upstream.body as never)) {
      size += (chunk as Uint8Array).length;
      if (size > limit) return null;
      chunks.push(chunk as Uint8Array);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The vendor's own words for a refused key, bounded, as one line. */
async function refusalOf(upstream: UpstreamResponse): Promise<string | null> {
  if (upstream.body === null) return null;
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_REFUSAL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let message: unknown = null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown } | null;
    const error = parsed?.error;
    message = typeof error === "object" && error !== null ? error.message : (parsed?.message ?? error);
  } catch {
    message = null;
  }
  if (typeof message !== "string" || message.trim().length === 0) return null;
  const line = clip(message.replace(/\s+/g, " ").trim());
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

function clip(text: string): string {
  return text.length <= MAX_QUOTED_CHARS ? text : `${text.slice(0, MAX_QUOTED_CHARS)}…`;
}
