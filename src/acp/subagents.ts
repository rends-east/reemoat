/**
 * Which tool call a tool call ran inside.
 *
 * ACP has no subagent concept at all — `ToolKind` is
 * `read|edit|delete|move|search|execute|think|fetch|switch_mode|other`, and the
 * SDK has no `parent_tool_use`, `sidechain` or `delegate` anywhere in it. So
 * every fact here rides `_meta`, which is agent-shaped by construction, and this
 * file is where that shape is allowed to be known. `src/acp/` is already the
 * directory for how each agent's dialect differs; `agents.ts` is nothing else.
 *
 * The safety argument for building on a field ACP does not define is that **the
 * failure mode is the status quo**: if `_meta.claudeCode` disappears in a later
 * adapter, every call comes back parentless and the transcript renders flat,
 * which is what it did before any of this existed.
 *
 * Measured 2026-08-01 against claude 2.1.220 / claude-agent-acp 0.63.0 and
 * kimi 0.29.2 — see `toolCallLineage` for what each one sends.
 */

/** What a tool call's metadata said about its lineage. */
export interface ToolCallLineage {
  /** The tool call this one ran inside, or `null` when nothing said. */
  parentToolCallId: string | null;
  /** The agent declared this call a subagent spawn. */
  subagent: boolean;
}

const NO_LINEAGE: ToolCallLineage = { parentToolCallId: null, subagent: false };

/**
 * The longest parent id that may become a tree edge.
 *
 * A bound is needed *here* because there is nowhere later to put one:
 * `truncateEvent` deliberately spreads this field through untouched on both arms
 * — a clipped edge is not a shorter field, it is an id naming a call that cannot
 * exist — so without a ceiling at ingest an agent could push an event past the
 * per-event cap with a field the truncator refuses to shrink, and the cap that
 * the bounds table calls enforced would quietly stop being.
 *
 * 256 rather than something tighter because the value is the agent's own
 * `toolCallId` and no spec bounds it; measured ids from claude and kimi are
 * under 40 characters, so this refuses only things that were never a real edge.
 *
 * Exported because `session.ts` bounds `toolCallId` itself with the same number:
 * the parent id **is** a tool call id — byte-for-byte the parent's own, per the
 * measurement below — so the call's own id had exactly the same hole and two
 * numbers for one quantity is how the pair drifts apart.
 */
export const MAX_PARENT_ID_CHARS = 256;

/**
 * Read lineage out of an ACP tool call's `_meta`, or answer that there is none.
 *
 * What each agent sends, measured rather than assumed:
 *
 * * **claude** stamps `_meta.claudeCode.subagent === true` on a spawn and
 *   `_meta.claudeCode.parentToolUseId` on the calls that ran inside it. The
 *   parent id is byte-for-byte the parent's own `toolCallId` — no prefix, no
 *   namespace — and the parent's `tool_call` always precedes its children.
 * * **kimi** sends no `_meta` at all, ever, and filters its subagents' events
 *   at the source (`isFromMainAgent`), so nothing is recoverable. It gets
 *   `subagent: false` **by absence rather than by our guessing**, which is the
 *   honest answer: its spawn tool is also called `Agent`, means something we
 *   cannot see inside of, and would be a lie under the same flag.
 *
 * This reads no tool name, deliberately. That is the sharpest available form of
 * the rule `agentConfig` states about `effort` versus `thinking` — and it costs
 * nothing here, because claude *declares* the flag itself.
 *
 * Cannot throw: it runs on the emit path, inside the agent's own RPC handler.
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
  // A string of a plausible length, or nothing. Never coerced: `String(42)` as a
  // tree edge is worse than no edge, because it names a call that will never
  // exist and the reader has no way to tell that from a parent that was merely
  // evicted. Over-long is refused for the same reason plus a size one — see
  // `MAX_PARENT_ID_CHARS`.
  const parent =
    typeof raw === "string" && raw.length > 0 && raw.length <= MAX_PARENT_ID_CHARS ? raw : null;

  return {
    // A tool call cannot run inside itself. That is arithmetic rather than a
    // fact about an agent, so it is normalized here; longer cycles are not
    // detectable without state this refuses to keep, and are bounded by the
    // reader's own depth limit instead.
    parentToolCallId: parent === update.toolCallId ? null : parent,
    // `=== true`, not truthiness, so the string "true" is false. Same discipline
    // as `alg === "EdDSA"` in `token.ts`: an exact comparison makes a whole
    // family of near-misses structurally impossible rather than defended one at
    // a time.
    subagent: (claudeCode as { subagent?: unknown }).subagent === true,
  };
}
