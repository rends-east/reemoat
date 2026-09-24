import { foldRuns } from "./webcheck.modules.js";

/** Every row key a reader can reach, with folded runs opened out. */
export type BuiltRows = Parameters<typeof foldRuns>[0];
export const drawn = (rows: BuiltRows): string[] =>
  rows.flatMap((row) => (row.kind === "group" ? row.children.map((child) => child.key) : [row.key]));
