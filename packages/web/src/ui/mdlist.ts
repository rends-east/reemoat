/**
 * What an ordered list was written with, kept as far as the DOM.
 *
 * Its own module rather than a block inside `Markdown.tsx` for one reason:
 * `webcheck` imports it. `Markdown.tsx` cannot be imported by anything offline —
 * it reaches react-markdown, `highlight.js` and a `useFileAccess` context — so a
 * plugin living there would be asserted only by reading the file as text, which
 * is what this repo does when it has no better option and not when it has one.
 */

/**
 * The class an ordered list wears when it was written with `)` rather than `.`.
 *
 * Not a Tailwind utility — the rule that reads it is in `index.css`, unlayered,
 * beside the other opt-in ones.
 */
export const PAREN_LIST = "md-paren";

/**
 * The shape this file needs from mdast, hand-written.
 *
 * `@types/mdast` is a transitive dependency of react-markdown and is **not
 * resolvable from `packages/web`** — neither is `unist-util-visit`, which is why
 * the walk below is four lines rather than an import. Adding either to make one
 * plugin typed would put a parser's whole type surface into this package's
 * manifest for a field mdast does not even carry.
 */
interface ListNode {
  type?: string;
  ordered?: boolean;
  position?: { start?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
  children?: unknown[];
}

/**
 * An ordered list keeps the delimiter somebody typed.
 *
 * `1)` and `1.` are both CommonMark — micromark's `list.js` tests for codepoint
 * 41 *or* 46 on the same line — but **mdast records neither**: a `list` node
 * carries `ordered`, `start` and `spread`, and the character is gone by the time
 * anything downstream could read it. So `list-style-type: decimal` drew `1.` over
 * a message that said `1)`, which is this app putting words in somebody's mouth
 * about the one text it has no business rewriting.
 *
 * The delimiter is still in the **source**, and a remark plugin is the last place
 * that holds both halves: `file.value`, and the node's own
 * `position.start.offset`. Measured against this repo's own remark-parse 11 — the
 * offset points at the digit and never at the indentation before it, so the
 * pattern needs no leading `\s*`. Nine digits because that is CommonMark's own
 * ceiling on a list number.
 *
 * It marks and never rewrites. What it sets is one class; `index.css` draws the
 * marker from it, and a browser that cannot style `::marker` still gets `1.` —
 * which is exactly what it drew before this existed, so the degradation is a
 * no-op rather than a fallback anybody has to look at.
 *
 * `unknown` on both parameters is deliberate. A transformer is contravariant in
 * them, so anything narrower than the tree type unified declares would fail at
 * the `remarkPlugins` array instead of here, where the narrowing is.
 */
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
