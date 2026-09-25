import type { PeerOrigin } from "./wire";

/** What the other agent wrote, without the envelope its daemon put round it; the text as it came when it is not one. */
export function peerBody(text: string): string {
  const head = /^<peer-(message|notice)\b[^>]*>/.exec(text);
  if (head === null) return text;
  const rest = text.slice(head[0].length);
  const end = rest.lastIndexOf(`</peer-${head[1]}>`);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/^\n/, "").replace(/\n$/, "");
}

export function peerHeadline(from: PeerOrigin): string {
  const who = from.machineLabel === null ? from.name : `${from.name} on ${from.machineLabel}`;
  return from.kind === "notice" ? `From ${who}` : `Message from ${who}`;
}
