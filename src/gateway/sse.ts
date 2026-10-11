import type { SseEvent } from "./translate/types.js";

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/** Events as they complete, whatever the chunking. An event the stream ended inside is never dispatched: the specification's rule, and what keeps a cut a cut. */
export function sseDecoder(): { push(chunk: Uint8Array | string): SseEvent[] } {
  const utf8 = new TextDecoder("utf-8");
  let line = "";
  let event = "";
  let data: string | null = null;
  let first = true;
  // A CR ended the last line, so an LF arriving next, in this chunk or the one after, belongs to it.
  let afterCarriageReturn = false;

  const take = (whole: string, out: SseEvent[]): void => {
    if (whole === "") {
      if (data !== null) out.push({ event: event === "" ? null : event, data });
      event = "";
      data = null;
      return;
    }
    const colon = whole.indexOf(":");
    if (colon === 0) return;
    const field = colon === -1 ? whole : whole.slice(0, colon);
    const rest = colon === -1 ? "" : whole.slice(colon + 1);
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;
    if (field === "event") event = value;
    else if (field === "data") data = data === null ? value : `${data}\n${value}`;
  };

  return {
    push(chunk) {
      let text = typeof chunk === "string" ? chunk : utf8.decode(chunk, { stream: true });
      if (first && text.length > 0) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      const out: SseEvent[] = [];
      let start = 0;
      for (let at = 0; at < text.length; at += 1) {
        const code = text.charCodeAt(at);
        if (afterCarriageReturn) {
          afterCarriageReturn = false;
          if (code === LINE_FEED) {
            start = at + 1;
            continue;
          }
        }
        if (code !== LINE_FEED && code !== CARRIAGE_RETURN) continue;
        take(line + text.slice(start, at), out);
        line = "";
        start = at + 1;
        afterCarriageReturn = code === CARRIAGE_RETURN;
      }
      line += text.slice(start);
      return out;
    },
  };
}

export function encodeSse(event: SseEvent): string {
  const name = event.event === null ? "" : `event: ${event.event}\n`;
  const lines = event.data.split(/\r\n|\r|\n/).map((line) => `data: ${line}\n`);
  return `${name}${lines.join("")}\n`;
}
