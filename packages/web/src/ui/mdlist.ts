export const PAREN_LIST = "md-paren";

// Hand-written: `@types/mdast` and `unist-util-visit` are not resolvable from this package.
interface ListNode {
  type?: string;
  ordered?: boolean;
  spread?: boolean;
  position?: { start?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: unknown[];
}

/** Marks `1)` lists; mdast drops the delimiter, so it is read from the source at the node's offset. */
export function remarkListDelimiter() {
  return (tree: unknown, file: unknown): undefined => {
    const held = (file as { value?: unknown } | null)?.value;
    const source = typeof held === "string" ? held : String(file);
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const node = value as ListNode;
      if (node.type === "list" && node.ordered === true) {
        const at = node.position?.start?.offset;
        if (typeof at === "number" && /^\d{1,9}\)/.test(source.slice(at, at + 12))) {
          node.data ??= {};
          node.data.hProperties = { ...node.data.hProperties, className: [PAREN_LIST] };
        }
      }
      if (Array.isArray(node.children)) for (const child of node.children) visit(child);
    };
    visit(tree);
    return undefined;
  };
}

/** The user's own soft breaks become `break` nodes; `pre-wrap` instead would draw every hard break twice. */
export function remarkHardBreaks(): (tree: unknown) => undefined {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as ListNode;
    if (!Array.isArray(node.children)) return;
    let split = false;
    const out: unknown[] = [];
    for (const child of node.children) {
      const text = child as { type?: string; value?: string } | null;
      if (text?.type === "text" && typeof text.value === "string" && text.value.includes("\n")) {
        split = true;
        // The blanks around the newline go with it, as a hard break's would.
        const parts = text.value.split(/[\t \r]*\n[\t \r]*/);
        parts.forEach((part, index) => {
          if (index > 0) out.push({ type: "break" });
          if (part.length > 0) out.push({ type: "text", value: part });
        });
      } else {
        visit(child);
        out.push(child);
      }
    }
    // Only when something split, so an unchanged text keeps its node identity.
    if (split) node.children = out;
  };
  return (tree: unknown): undefined => {
    visit(tree);
    return undefined;
  };
}

/** Spreads an item mixing a sentence and a block, so the sentence gets a real box for WebKit selection; costs no pixels. */
export function remarkListItemBlocks(): (tree: unknown) => undefined {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as ListNode;
    if (!Array.isArray(node.children)) return;
    if (node.type === "listItem") {
      let sentence = false;
      let block = false;
      for (const child of node.children) {
        const kind = (child as { type?: string } | null)?.type;
        if (kind === "paragraph") sentence = true;
        else if (kind !== undefined) block = true;
      }
      if (sentence && block) node.spread = true;
    }
    for (const child of node.children) visit(child);
  };
  return (tree: unknown): undefined => {
    visit(tree);
    return undefined;
  };
}
