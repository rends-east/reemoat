// Tool-call lineage, which ACP does not define, read from the claudeCode _meta; if it disappears the transcript renders flat, as before.

export interface ToolCallLineage {
  parentToolCallId: string | null;
  subagent: boolean;
}

const NO_LINEAGE: ToolCallLineage = { parentToolCallId: null, subagent: false };

/** Bounded at ingest because truncateEvent never shrinks an edge; session.ts bounds toolCallId with the same number. */
export const MAX_PARENT_ID_CHARS = 256;

/**
 * Reads claude's declared subagent flag and parent id, never a tool name; kimi sends none.
 * Cannot throw: it runs inside the agent's RPC handler.
 */
export function toolCallLineage(update: {
  toolCallId: string;
  _meta?: unknown;
}): ToolCallLineage {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return NO_LINEAGE;
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  if (typeof claudeCode !== "object" || claudeCode === null) return NO_LINEAGE;

  const raw = (claudeCode as { parentToolUseId?: unknown }).parentToolUseId;
  // Never coerced: a non-string edge names a call that will never exist.
  const parent =
    typeof raw === "string" && raw.length > 0 && raw.length <= MAX_PARENT_ID_CHARS ? raw : null;

  return {
    // A call cannot run inside itself; longer cycles are left to the reader's depth limit.
    parentToolCallId: parent === update.toolCallId ? null : parent,
    subagent: (claudeCode as { subagent?: unknown }).subagent === true,
  };
}
