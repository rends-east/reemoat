/**
 * Reading a built tail as the keys a person can actually see.
 *
 * Shared by the three sections that assert about the cut, the parenting and the
 * folding. Two other sections declare their own `drawn` for something else
 * entirely — those are local and stay local.
 */

import { foldRuns } from "./webcheck.modules.js";

/**
 * Every row a reader can reach, with folded runs opened out.
 *
 * `buildTail` collapses a run of consecutive tool rows into one `group`, so a bare
 * `rows.map(r => r.key)` stopped describing what is *drawn* and started describing
 * how it is packaged. The assertions below are about the cut, the gaps and the
 * parenting — none of them is about folding, and each keeps its original claim by
 * reading through a group rather than being rewritten around one.
 *
 * Folding gets its own section, further down, where the packaging is the subject.
 */
export type BuiltRows = Parameters<typeof foldRuns>[0];
export const drawn = (rows: BuiltRows): string[] =>
  rows.flatMap((row) => (row.kind === "group" ? row.children.map((child) => child.key) : [row.key]));
