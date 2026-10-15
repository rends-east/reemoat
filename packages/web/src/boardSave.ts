/**
 * Saving the account's board: every reachable machine that runs it is written, each against the revision it was read at, and
 * what each answered is said in words. Pure, no DOM: webcheck imports it.
 */

import { ApiError, errorText } from "./http";
import type { MachineId } from "./ids";
import type { Reach } from "./machine";
import type { BoardWritten } from "./wire";

/** Where the caret goes for a refusal at `line`:`col`, both counted from 1 as the parser counts them. */
export function offsetOf(text: string, line: number, col: number): number {
  let at = 0;
  for (let n = 1; n < line; n += 1) {
    const next = text.indexOf("\n", at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  const end = text.indexOf("\n", at);
  return Math.min(at + Math.max(0, col - 1), end < 0 ? text.length : end);
}

export interface SaveMachine {
  id: MachineId;
  name: string;
  reach: Reach;
  /** It may be written: its grant carries `session:write`. */
  writable: boolean;
  /** Its tasks have been read since launch, so its silence about the board is an answer. */
  read: boolean;
}

export type SkipWhy = "unreachable" | "read_only" | "older" | "unread";

export interface SavePlan {
  targets: { id: MachineId; name: string; revision: number }[];
  skipped: { id: MachineId; name: string; why: SkipWhy }[];
}

export function savePlan(machines: readonly SaveMachine[], configured: ReadonlyMap<MachineId, { revision: number }>): SavePlan {
  const plan: SavePlan = { targets: [], skipped: [] };
  for (const machine of machines) {
    const stamp = configured.get(machine.id);
    const why: SkipWhy | null =
      stamp === undefined ? (machine.read ? "older" : "unread") : machine.reach !== "online" ? "unreachable" : !machine.writable ? "read_only" : null;
    if (why !== null) plan.skipped.push({ id: machine.id, name: machine.name, why });
    else plan.targets.push({ id: machine.id, name: machine.name, revision: stamp!.revision });
  }
  return plan;
}

export interface RefusedLine {
  line: number;
  col: number;
  path: string;
  message: string;
  text: string;
}

export type SaveOutcome =
  | { kind: "saved"; changed: boolean; revision: number }
  | { kind: "conflict"; revision: number; hash: string; text: string }
  | { kind: "refused"; errors: RefusedLine[]; message: string }
  | { kind: "failed"; message: string }
  | { kind: "skipped"; why: SkipWhy };

function readRefusals(detail: unknown): RefusedLine[] {
  const errors = typeof detail === "object" && detail !== null ? (detail as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((one): RefusedLine[] => {
    if (typeof one !== "object" || one === null) return [];
    const row = one as Record<string, unknown>;
    const line = typeof row["line"] === "number" ? row["line"] : 1;
    const col = typeof row["col"] === "number" ? row["col"] : 1;
    const message = typeof row["message"] === "string" ? row["message"] : "";
    const path = typeof row["path"] === "string" ? row["path"] : "";
    const text = typeof row["text"] === "string" ? row["text"] : `${line}:${col} ${path.length === 0 ? "board" : path}: ${message}`;
    return [{ line, col, path, message, text }];
  });
}

/** One machine's answer to a write, as the screen says it. A conflict carries the board that machine holds now. */
export function saveOutcome(answer: { ok: true; written: BoardWritten } | { ok: false; cause: unknown }): SaveOutcome {
  if (answer.ok) return { kind: "saved", changed: answer.written.changed, revision: answer.written.revision };
  const { cause } = answer;
  if (ApiError.isApiError(cause) && cause.code === "board_revision") {
    const detail = (cause.detail ?? {}) as { revision?: unknown; hash?: unknown; text?: unknown };
    if (typeof detail.revision === "number" && typeof detail.hash === "string" && typeof detail.text === "string") {
      return { kind: "conflict", revision: detail.revision, hash: detail.hash, text: detail.text };
    }
  }
  if (ApiError.isApiError(cause) && cause.code === "board_invalid") return { kind: "refused", errors: readRefusals(cause.detail), message: cause.message };
  return { kind: "failed", message: errorText(cause) };
}

const SKIP_TEXT: Record<SkipWhy, string> = {
  unreachable: "not reachable now, so not written",
  read_only: "read-only for you, so not written",
  older: "runs no configurable board, so not written",
  unread: "not read yet, so not written",
};

export function outcomeSentence(outcome: SaveOutcome): string {
  switch (outcome.kind) {
    case "saved":
      return outcome.changed ? `saved, revision ${outcome.revision}` : "already held this board";
    case "conflict":
      return `changed meanwhile, now at revision ${outcome.revision}; nothing was written`;
    case "refused":
      return outcome.errors.length === 1 ? "refused it for one reason" : `refused it for ${outcome.errors.length} reasons`;
    case "failed":
      return outcome.message;
    case "skipped":
      return SKIP_TEXT[outcome.why];
  }
}
