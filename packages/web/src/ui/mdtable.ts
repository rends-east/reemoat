export const SHORT_COLUMN = "md-short";

/** A column whose every cell, header included, is at most this long never wraps (Q3.705). */
export const SHORT_CELL_CHARS = 12;

// Hand-written for mdlist.ts's reason: the mdast types are not resolvable from this package.
interface MdNode {
  type?: string;
  value?: unknown;
  children?: unknown[];
  data?: { hProperties?: Record<string, unknown> };
}

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => textOf(child as MdNode)).join("");
}

/** Marks every cell of a short column, so `≈ 61` stays one line beside a column of prose. */
export function remarkShortColumns(): (tree: unknown) => undefined {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const node = value as MdNode;
    if (node.type === "table") markShort(node);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  return (tree) => {
    visit(tree);
    return undefined;
  };
}

function markShort(table: MdNode): void {
  const rows = (table.children ?? []) as MdNode[];
  const widest: number[] = [];
  for (const row of rows) {
    (row.children ?? []).forEach((cell, at) => {
      widest[at] = Math.max(widest[at] ?? 0, Array.from(textOf(cell as MdNode).trim()).length);
    });
  }
  for (const row of rows) {
    (row.children ?? []).forEach((value, at) => {
      if ((widest[at] ?? Number.POSITIVE_INFINITY) > SHORT_CELL_CHARS) return;
      const cell = value as MdNode;
      cell.data ??= {};
      cell.data.hProperties = { ...cell.data.hProperties, className: [SHORT_COLUMN] };
    });
  }
}
