import type { PeerOrigin } from "./wire";

/** What the other agent wrote, without the envelope its daemon put round it; the text as it came when it is not one. */
export function peerBody(text: string): string {
  const head = /^<peer-(message|notice)\b[^>]*>/.exec(text);
  if (head === null) return text;
  const rest = text.slice(head[0].length);
  const end = rest.lastIndexOf(`</peer-${head[1]}>`);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/^\n/, "").replace(/\n$/, "");
}

/** The headline in three pieces, so the name between them can be drawn as a link to its session; every nickname wears its `@`. */
export function peerHeadlineParts(from: PeerOrigin): { lead: string; name: string; where: string } {
  return {
    lead: from.kind === "notice" ? "From" : "Message from",
    name: from.name,
    where: from.machineLabel === null ? "" : ` on ${from.machineLabel}`,
  };
}

export function peerHeadline(from: PeerOrigin): string {
  const { lead, name, where } = peerHeadlineParts(from);
  return `${lead} @${name}${where}`;
}
