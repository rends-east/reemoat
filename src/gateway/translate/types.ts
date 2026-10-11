import type { WireProtocol } from "../../acp/systems.js";

export interface SseEvent {
  event: string | null;
  data: string;
}

export interface TranslateContext {
  /** The model the launch is held to; echoed where the inbound protocol wants a model name. */
  model: string;
}

/** A sentence naming what could not be carried, for the transcript. */
export type Untranslatable = { untranslatable: string };

export interface Translator {
  inbound: WireProtocol;
  outbound: WireProtocol;
  /** The outbound request body for an inbound one, or what in it cannot be carried. */
  request(body: unknown, context: TranslateContext): { body: unknown } | Untranslatable;
  /** A whole (non-streamed) outbound answer as an inbound one. */
  whole(status: number, body: unknown, context: TranslateContext): unknown;
  /** One answer's stream: outbound events in, inbound events out; end() flushes and must leave the inbound stream well-formed even when the outbound one was cut. */
  stream(context: TranslateContext): { push(event: SseEvent): SseEvent[]; end(): SseEvent[] };
  /** An outbound error body (status >= 400) in the inbound protocol's error shape. */
  error(status: number, body: unknown): unknown;
}
