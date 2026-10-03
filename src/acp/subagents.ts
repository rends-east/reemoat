// Tool-call lineage and when a delegation ends, which ACP does not define, read from the claudeCode _meta; if it disappears the
// transcript renders flat and a backgrounded subagent reads as finished, as before.

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

/**
 * claude's own name for the tool behind a call, as its adapter declares it; read to recognise this daemon's MCP tools and the
 * one call that ends a backgrounded subagent.
 */
export function claudeToolName(update: { _meta?: unknown }): string | null {
  const name = claudeCodeMeta(update)?.["toolName"];
  return typeof name === "string" ? name : null;
}

/** The call answered that its work runs on after it: claude's Agent and Workflow say `async_launched` (Q6.119). */
export function launchedInBackground(update: { _meta?: unknown }): boolean {
  const response = claudeCodeMeta(update)?.["toolResponse"];
  return typeof response === "object" && response !== null && (response as { status?: unknown }).status === "async_launched";
}

/** "The call ends your run": how a backgrounded subagent hands its report back, in auto mode (Q6.119). */
const SUBAGENT_HANDBACK = "SubagentHandback";

/** A delegated step that is its delegation's last, by the tool's own contract; only ever true under a parent. */
export function endsDelegation(update: { _meta?: unknown }, lineage: ToolCallLineage): boolean {
  return lineage.parentToolCallId !== null && claudeToolName(update) === SUBAGENT_HANDBACK;
}

function claudeCodeMeta(update: { _meta?: unknown }): Record<string, unknown> | null {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null) return null;
  const claudeCode = (meta as { claudeCode?: unknown }).claudeCode;
  return typeof claudeCode === "object" && claudeCode !== null ? (claudeCode as Record<string, unknown>) : null;
}
