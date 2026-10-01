import type { PromptMention } from "./wire";

// Where an `@name` in drawn text leads: pure, so the transcript, the bubble and webcheck share one reading. Q3.682.

/** The daemon's token rule (`MENTION` in src/peers/hub.ts): at the start or after whitespace, and only where a name ends. */
const MENTION = /(^|\s)@([A-Za-z][A-Za-z0-9-]{1,31})(?![A-Za-z0-9@/-])/g;

export type MentionPart = { kind: "text"; text: string } | { kind: "mention"; name: string };

/** Text and `@name` tokens in order; the `@` belongs to the token, the whitespace before it to the text. */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const at = (match.index ?? 0) + (match[1] ?? "").length;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    parts.push({ kind: "mention", name: match[2] ?? "" });
    last = at + 1 + (match[2] ?? "").length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export interface MentionTarget {
  machineId: string;
  sessionId: string;
}

/** A daemon's ref: `machine/session` names another machine, a bare id one on `here`. */
export function refTarget(ref: string, here: string): MentionTarget {
  const slash = ref.indexOf("/");
  return slash < 0 ? { machineId: here, sessionId: ref } : { machineId: ref.slice(0, slash), sessionId: ref.slice(slash + 1) };
}

interface MentionRow {
  ref: { machineId: string; sessionId: string };
  snapshot: { nickname?: string | null };
}

/**
 * The session a name leads to, or null where none this client can open answers to it. The daemon's own resolution wins
 * (a prompt's `mentions`, a peer's ref); otherwise a nickname here, then one held by exactly one session anywhere.
 */
export function mentionTarget(
  name: string,
  scope: { here: string | null; mentions?: readonly PromptMention[]; exact?: MentionTarget | null },
  rows: readonly MentionRow[],
): MentionTarget | null {
  const visible = (target: MentionTarget): boolean =>
    rows.some((row) => row.ref.machineId === target.machineId && row.ref.sessionId === target.sessionId);
  if (scope.exact != null) return visible(scope.exact) ? scope.exact : null;
  const wanted = name.toLowerCase();
  const logged = scope.here === null ? undefined : scope.mentions?.find((one) => one.name.toLowerCase() === wanted);
  if (logged !== undefined && scope.here !== null) {
    const target = refTarget(logged.ref, scope.here);
    if (visible(target)) return target;
  }
  const named = rows.filter((row) => row.snapshot.nickname?.toLowerCase() === wanted);
  const here = named.filter((row) => row.ref.machineId === scope.here);
  const only = here.length === 1 ? here[0] : named.length === 1 ? named[0] : undefined;
  return only === undefined ? null : { machineId: only.ref.machineId, sessionId: only.ref.sessionId };
}

// Hand-written for the reason `mdlist.ts` gives: the mdast types are not resolvable from this package.
interface MdNode {
  type?: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Each `@name` in prose as a `mention` element, never inside a link or code, which react-markdown draws as `MentionLink`. */
export function remarkMentions(): (tree: unknown) => undefined {
  const visit = (node: MdNode): void => {
    if (!Array.isArray(node.children) || node.type === "link" || node.type === "linkReference") return;
    const next: MdNode[] = [];
    let changed = false;
    for (const child of node.children) {
      const parts = child.type === "text" && typeof child.value === "string" ? splitMentions(child.value) : null;
      if (parts !== null && parts.some((part) => part.kind === "mention")) {
        changed = true;
        for (const part of parts) {
          next.push(
            part.kind === "text"
              ? { type: "text", value: part.text }
              : { type: "mention", children: [], data: { hName: "mention", hProperties: { name: part.name } } },
          );
        }
        continue;
      }
      next.push(child);
      visit(child);
    }
    if (changed) node.children = next;
  };
  return (tree) => {
    visit(tree as MdNode);
    return undefined;
  };
}
