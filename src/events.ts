import type {
  PermissionOptionKind,
  PlanEntry,
  StopReason,
  ToolCallStatus,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";
import type { AgentId } from "./acp/agents.js";
import { describeError } from "./http.js";

/**
 * The normalized event stream.
 *
 * Every agent collapses into this union, so anything built on top of a session —
 * the daemon, the browser client, the phone — only ever has to understand these
 * shapes, never the per-agent ACP dialect.
 *
 * Optional data is modelled as `T | null` rather than `?:` so that every event
 * serializes to a stable JSON shape.
 */
export type SessionEvent =
  | SessionStartedEvent
  | AgentConfigEvent
  | TextEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | FileChangeEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | ElicitationRequestEvent
  | ElicitationResolvedEvent
  | PlanEvent
  | PromptEvent
  | StatusEvent
  | WorkspaceEvent
  | TurnEndEvent
  | AgentLogEvent
  | ContextClearedEvent
  | OtherUpdateEvent
  | ErrorEvent;

export interface FileLocation {
  path: string;
  line: number | null;
}

export interface PermissionOptionSummary {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

/** One choice on an elicitation field, from either `enum` or `oneOf`. */
export interface ElicitationOption {
  /** What goes back on the wire — an `EnumOption.const`, or the bare string. */
  value: string;
  /** What a person reads — an `EnumOption.title`, or the value again. */
  label: string;
  description: string | null;
}

/**
 * One question on a form the agent is asking, projected and bounded.
 *
 * ACP's `ElicitationPropertySchema` is an open union of JSON-Schema fragments;
 * this is the fixed-shape subset this system carries. Projected in `session.ts`
 * at ingest, for the reason `toCommands` gives — the agent chooses the strings,
 * so "bounded by what the agent sent" is not a bound — and *here* in `events.ts`
 * rather than beside the projection because it crosses the wire on an event and
 * on the snapshot both, which is the same reason `PermissionOptionSummary` is
 * here.
 *
 * `pattern` is deliberately absent. It is an agent-chosen regular expression, and
 * running one against user input in this process is a ReDoS on the event loop —
 * the same class of hazard as a synchronous stat on a hung mount, through another
 * door. Carrying it for a client to enforce only moves the hazard into a tab.
 * `min`/`max`/`format` are constant-time and are kept.
 */
export interface ElicitationField {
  key: string;
  kind: "string" | "number" | "integer" | "boolean" | "multi_select";
  title: string | null;
  description: string | null;
  required: boolean;
  /** Present for a single- or multi-select, `null` for a free value. */
  options: ElicitationOption[] | null;
  /** `minLength` | `minimum` | `minItems`, by kind. */
  min: number | null;
  /** `maxLength` | `maximum` | `maxItems`, by kind. */
  max: number | null;
  /** An input hint. Enforced by nobody — see `validateElicitationContent`. */
  format: "email" | "uri" | "date" | "date-time" | null;
  default: string | number | boolean | string[] | null;
}

/** What the agent asked, as a form somebody can be shown. */
export interface ElicitationForm {
  fields: ElicitationField[];
}

/** One answer, already rendered for reading. */
export interface ElicitationAnswer {
  key: string;
  /** The field's `title`, or its `key` when the agent gave none. */
  label: string;
  /** The chosen option's `label`, or the typed text. Never a wire value. */
  value: string;
}

export interface SessionStartedEvent {
  type: "session_started";
  agent: AgentId;
  sessionId: string;
  agentInfo: { name: string; version: string } | null;
  /**
   * Permission/plan modes, when the agent fills in ACP's legacy `modes` field.
   *
   * Claude does and kimi does not — but kimi is not modeless, it publishes the
   * same taxonomy through `configOptions` under `category: "mode"` instead. So
   * this is a fact about which field an adapter populates, not about what it can
   * do, and {@link AgentConfigEvent} is the one to render.
   */
  modes: AgentModes | null;
}

/** One selectable value of a select-shaped {@link AgentConfigOption}. */
export interface AgentConfigChoice {
  value: string;
  name: string;
  description: string | null;
  /** The heading this value sits under, when the agent grouped its choices. */
  group: string | null;
}

/**
 * One knob the agent exposes, flattened out of ACP's `SessionConfigOption`.
 *
 * `category` is ACP's own UX hint — `"mode" | "model" | "model_config" |
 * "thought_level"`, or anything else an agent invents — and it is the **only**
 * portable way to know what a knob means, because the ids are not stable across
 * agents: claude calls reasoning effort `effort` with values
 * `default|low|…|max`, kimi calls it `thinking` with values `off|…`. A client
 * keying on the id renders one agent's controls and none of the other's.
 *
 * The spec is explicit that `category` "MUST NOT be required for correctness",
 * so an unknown or absent one has to render as a plain labelled control rather
 * than disappear.
 */
export interface AgentConfigOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: "select" | "boolean";
  /** A choice's `value` when `kind` is `"select"`, the toggle state otherwise. */
  value: string | boolean;
  /** Empty for a boolean. */
  choices: AgentConfigChoice[];
}

export interface AgentModes {
  current: string;
  available: { id: string; name: string; description: string | null }[];
}

/**
 * Everything an agent will let a client change mid-session.
 *
 * **Always the complete state, never a delta.** ACP's `current_mode_update`
 * carries only the new mode id, but this event is what a snapshot is rebuilt
 * from, so `session.ts` merges such an update against the last known state
 * before emitting. A client that received a partial here would have to keep its
 * own reducer and would disagree with the snapshot the moment it missed one.
 *
 * Emitted on session start, on every agent-initiated change, and after every
 * accepted `POST /sessions/:id/config` — agents change these themselves (claude
 * flips to `plan` from its own hook, and clamps the mode when a model switch
 * makes the current one impossible), so a client must render from this rather
 * than from what it last asked for.
 */
export interface AgentConfigEvent {
  type: "agent_config";
  modes: AgentModes | null;
  options: AgentConfigOption[];
}

/** The payload half of {@link AgentConfigEvent}, as carried on a session snapshot. */
export type AgentConfig = Omit<AgentConfigEvent, "type">;

/**
 * How full the model's context window is, right now.
 *
 * **Not {@link TurnEndEvent}'s `usage`**, and the two must never be merged. That
 * one is ACP's `Usage`: cumulative token *counts* for one turn — narrative, in the
 * log, one per turn. This is *occupancy of the window at this instant* — state, on
 * the snapshot, and deliberately nowhere else. Measured 2026-07-31 against
 * claude-agent-acp 0.63.0, `usage_update` fires on every streaming token delta, so
 * putting it in the log would spend the 5000-event budget on a number that is
 * superseded microseconds later and evict the transcript it sits beside.
 *
 * Flattened out of ACP's `UsageUpdate` for the same reason `AgentConfigOption` is
 * flattened out of `SessionConfigOption`: `_meta` is unbounded and agent-specific,
 * and this rides a record `GET /sessions` returns sixty of at a time.
 *
 * `size` is 0 for "the agent did not say", never a guessed default — a consumer
 * divides by it, and a made-up denominator produces a percentage nobody measured.
 */
export interface ContextUsage {
  /**
   * What the agent says is in the window, and **the agent decides what that
   * means** — this daemon does not compute it and cannot check it.
   *
   * Read as occupancy, and on codex that is true by a mechanism rather than by
   * definition: measured 2026-08-07 against codex-acp 1.1.9, its adapter fills
   * this from `lastTokenUsage.totalTokens`, i.e. the tokens of the **last turn**.
   * It tracks occupancy only because codex re-sends the whole conversation as
   * input on every request, so the last turn's input *is* the window. An agent
   * that sent deltas instead would put a per-turn number here and nothing would
   * notice — which is why the honest name for this field is "what the agent
   * reported", and why {@link ContextUsage} is snapshot-only state rather than
   * something a consumer may do arithmetic across.
   */
  used: number;
  /** How large the window is, or 0 when the agent did not say. */
  size: number;
  /** What the session has cost so far, when the agent reports it. */
  cost: { amount: number; currency: string } | null;
}

/**
 * One command the agent will answer to a leading slash.
 *
 * ACP's whole command surface is the `available_commands_update` arm of
 * `session/update`, and its whole *argument* surface is a hint string: there is
 * no schema, no enums, no `commands/list` RPC and no `session/execute_command`.
 * So a command is invoked by sending `"/name args"` through `session/prompt`
 * like any other text, and `hint` is prose for a placeholder rather than a
 * template anything fills in.
 *
 * Flattened out of ACP's `AvailableCommand` for the reason {@link ContextUsage}
 * is flattened out of `UsageUpdate`: `_meta` is unbounded and agent-shaped.
 */
export interface AgentCommand {
  /** Without the leading slash, as the agent published it. */
  name: string;
  description: string;
  /** ACP's `input.hint`, or `null` when the command takes no argument. */
  hint: string | null;
}

/**
 * The agent's whole command list, and how much of it was cut off.
 *
 * **Full replacement, never a delta.** ACP defines the notification that way and
 * the adapter's own comment tells clients to replace their cached list — merging
 * would resurrect a command the agent has withdrawn, and the agent would then
 * refuse the thing its own menu offered.
 *
 * `dropped` is carried rather than swallowed, because a picker that quietly
 * offers less than the agent supports is the exact failure `truncateEvent`'s
 * `agent_config` arm names by hand.
 *
 * Deliberately **not** a member of {@link AgentConfig}. That type means "what a
 * caller may change", which is why {@link ContextUsage} is not in it either; a
 * command is invokable, not settable. Widening it would also feed a command list
 * into `applyAgentConfig`, which appends to a 5000-event log that evicts a
 * *prefix* — so every mode toggle would re-record the list by evicting the
 * operator's own first prompt.
 */
export interface AgentCommands {
  commands: AgentCommand[];
  dropped: number;
}

/** A chunk of model output. `thought` marks reasoning rather than reply text. */
export interface TextEvent {
  type: "text";
  role: "agent" | "user";
  thought: boolean;
  text: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: FileLocation[];
  rawInput: unknown;
  /**
   * The tool call this one ran *inside*, when the agent said so.
   *
   * A tree edge and nothing more — no depth, no subagent id, no orchestration.
   * Depth is *derived* from the chain rather than stored, because a stored copy
   * disagrees with it the moment the parent is evicted below `firstSeq`, and the
   * log evicts a prefix, so that is the common case and not an edge case.
   *
   * `null` means nothing said, which covers three genuinely different situations
   * that a reader must treat the same way: a top-level call, an agent that does
   * not report lineage at all (kimi), and a daemon older than this field. See
   * `toolCallLineage`.
   */
  parentToolCallId: string | null;
  /**
   * The agent declared this call a spawn of a subagent.
   *
   * Recorded because the agent said it, and deliberately **not** what a client
   * keys its *layout* on: `packages/web` nests, counts and summarises from
   * children, which is the only rule that degrades correctly against an agent
   * that says nothing. What it does key on this is whether the call is drawn as
   * a delegation at all — a spawn whose delegate makes no attributed tool call
   * has no children ever, and claude's spawn is `kind: "think"`, so without this
   * the same act renders as a robot or as a brain depending on what the delegate
   * happened to do.
   *
   * Measured 2026-08-01 — claude drops this flag on the spawn's own completing
   * update, which is why it is read from the call and never merged from one. It
   * is *not* copied onto `ToolCallUpdateEvent` (see `session.ts`): an update
   * saying nothing about it would otherwise be indistinguishable from an update
   * denying it.
   */
  subagent: boolean;
}

export interface ToolCallUpdateEvent {
  type: "tool_call_update";
  toolCallId: string;
  title: string | null;
  status: ToolCallStatus | null;
  locations: FileLocation[];
  /**
   * The arguments, when the agent filled them in on the update rather than the
   * call.
   *
   * ACP's `ToolCallUpdate` has always carried this and this daemon did not copy
   * it, so an agent that announces a bare `tool_call` and supplies the arguments
   * afterwards lost them entirely — the mirror image of the kimi problem
   * `session.ts` documents, where the arguments only ever appear on the permission
   * request. Bounded by the same `clampBlob` the call's own `rawInput` is.
   */
  rawInput: unknown;
  /**
   * Images the tool handed back, kept rather than discarded.
   *
   * ACP lets a tool return an `image` content block, and claude and kimi both use it —
   * measured, three times in one database, all from `Read` on a picture. It was
   * rendered as the literal string `[image]` and the bytes were dropped on the
   * floor, which is why asking an agent "what is in this screenshot" produced a
   * transcript that could not show the screenshot.
   *
   * **A reference, never the bytes.** Base64 on the event would be catastrophic
   * here: the tool-output budget is 32 KiB and the per-event cap 128 KiB, against
   * a log of 8 MiB per session that evicts a *prefix* — one photograph would
   * evict the conversation it belongs to. The bytes go to the upload root and
   * this names them.
   */
  images: StoredFileRef[] | null;
  /**
   * What the tool said, as plain text blocks.
   *
   * ACP sends a tool's output in `content`, and until now `session.ts` fed that to
   * `emitDiffs` — which keeps `type: "diff"` blocks and drops everything else — so
   * the output of every command an agent ran was thrown away at the daemon and no
   * client could show it however it was written. Only text survives here;
   * `type: "terminal"` is a live handle rather than a value and stays dropped.
   *
   * `null` means the update carried none, which is different from `[]`: an empty
   * array is a tool that answered with nothing, and a client may say so.
   *
   * Capped well below the 128 KiB per-event ceiling by `MAX_TOOL_OUTPUT_BYTES` in
   * `session.ts`, which is where it is applied — at the point the blocks are built
   * out of ACP's `content`, so an oversized payload is never assembled whole on
   * the agent's own RPC handler. Tool output is the largest thing an agent emits —
   * a `cat` of a big file, a full test run — and the per-event cap is a backstop
   * against one enormous event, not a budget for the commonest one.
   */
  content: string[] | null;
  /**
   * See {@link ToolCallEvent.parentToolCallId}.
   *
   * Measured 2026-08-01 against claude-agent-acp 0.63.0: **4 of 10** and **5 of
   * 14** of a child's updates arrive with no parent even though its `tool_call`
   * carried one — the `toolResponse`-bearing updates rebuild their metadata from
   * the tool *result* and do not re-derive lineage. So `null` here means "this
   * update did not say", never "top level", and a reader must take the lineage
   * first-non-null and never let a later `null` reset it.
   */
  parentToolCallId: string | null;
}

/**
 * A file the agent changed.
 *
 * Fed from two places, because the agents differ: Claude reports edits as `diff`
 * content inside tool calls, while Kimi routes writes back through the client as
 * `fs/write_text_file` requests. `source` says which path produced this event.
 */
export interface FileChangeEvent {
  type: "file_change";
  path: string;
  oldText: string | null;
  newText: string;
  source: "diff" | "fs_write";
  toolCallId: string | null;
}

/**
 * The agent asked for approval.
 *
 * Two producers, distinguished by `permissionId`. The daemon mints an id, parks
 * the agent's request and lets a remote client answer it, so `permissionId` is
 * set and `decision` is null until a matching `permission_resolved` arrives. A
 * bare `Session` with no resolver answers locally and reports the outcome inline:
 * `permissionId` null, `decision` already filled in, no resolution event.
 */
export interface PermissionRequestEvent {
  type: "permission_request";
  permissionId: string | null;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  /** The `optionId` we answered with, or null if we cancelled or are still waiting. */
  decision: string | null;
}

/**
 * Who settled a parked question. Only `client` is a human decision.
 *
 * Named for *answers* rather than for permissions because there are two kinds of
 * them now — an approval and an elicitation — and every member here applies
 * verbatim to both. Two identical unions would be worse than one slightly wide
 * name, but a type called `Permission*` sitting on an elicitation event is the
 * failure the `owned` → `sessionOf` rename is an invariant about: a name that
 * asserts a property nobody enforces. The string values are unchanged, so
 * nothing on disk moved.
 */
export type AnswerResolvedBy =
  | "client"
  | "agent_withdrew"
  | "agent_gone"
  | "session_stopped"
  | "turn_ended"
  | "pump_failed"
  | "no_turn"
  /**
   * Somebody stopped the turn while this was parked on them.
   *
   * Its own member rather than `session_stopped`, which is the nearest and is
   * wrong in the way that matters: that one says the session is over and this one
   * says it is still here and idle. Nor `turn_ended`, which is what the *pump*
   * writes once the agent has answered — this is written before that, by the
   * cancel itself, because ACP requires the client to answer a pending
   * `session/request_permission` with `cancelled` after sending `session/cancel`
   * and an agent blocked on one never reaches its own turn end until we do.
   */
  | "turn_cancelled";

export interface PermissionResolvedEvent {
  type: "permission_resolved";
  permissionId: string;
  toolCallId: string | null;
  /** Repeated from the request so an orphaned resolution is still self-describing. */
  title: string;
  outcome: "selected" | "cancelled";
  optionId: string | null;
  by: AnswerResolvedBy;
}

/**
 * The agent asked the person a question.
 *
 * In the log rather than on the snapshot alone, and it earns that in the most
 * literal way this vocabulary allows: the answer is folded back into the tool's
 * own input, so **what somebody typed enters the model's context**. It is not
 * superseded the way a token count is, not replaced whole the way a command list
 * is, and it happens exactly once with a before and an after. Leaving it out
 * would put a tool call in the transcript whose input references an answer whose
 * question appears nowhere.
 *
 * The **form is not here** — only the prompt. An unanswered request needs no more
 * than its message to draw, a resolved one is self-describing below, and the
 * fields are agent-shaped and unbounded until the projection clamps them. They
 * live on the pending record instead and are fetched by
 * `GET /sessions/:id/elicitations/:elicitationId`, which is the same place a
 * command list lives and for the same reason.
 */
export interface ElicitationRequestEvent {
  type: "elicitation_request";
  elicitationId: string;
  /** The tool call this question belongs to, when the agent named one. */
  toolCallId: string | null;
  /** The agent's own prose, clipped at ingest. */
  message: string;
}

export interface ElicitationResolvedEvent {
  type: "elicitation_resolved";
  elicitationId: string;
  toolCallId: string | null;
  /** Repeated from the request so an orphaned resolution is self-describing. */
  message: string;
  action: "accept" | "decline" | "cancel";
  /**
   * What was answered, already rendered — so a transcript needs no join.
   *
   * **This is the one place the permission pair above is deliberately not
   * copied.** `PermissionResolvedEvent` carries only an `optionId`, so a client
   * has to join back to the request's `options` to learn whether the answer was
   * an approval or a refusal — and while that join was missing, a refused command
   * was drawn with a check mark, and once the request row was merged away that
   * was the only record of the answer. A resolution has to be self-describing or
   * the same defect recurs one feature over.
   *
   * `value` is the chosen option's **label** and never its wire value: a wire
   * value is what the agent recognises, a label is the words the person read and
   * tapped. Each is clipped for the log alone; what reaches the agent is
   * verbatim, because a shortened answer is a wrong answer.
   *
   * `null` for `decline` and `cancel`, which are answers *about* the form rather
   * than within it.
   */
  answers: ElicitationAnswer[] | null;
  by: AnswerResolvedBy;
}

export interface PlanEvent {
  type: "plan";
  entries: PlanEntry[];
}

/**
 * A file this daemon has on disk and can serve, named on an event.
 *
 * No path and no URL — a location is a fact about one daemon's disk and the log
 * outlives it. A client rebuilds the download URL from `(sessionId, uploadId)`,
 * which are the two things that do not move.
 */
export interface StoredFileRef {
  uploadId: string;
  /** The stored name: a single sanitized segment. */
  name: string;
  mime: string | null;
  bytes: number;
}

/**
 * One file that rode a prompt.
 *
 * **No path and no URL.** A filesystem location is a fact about *this* daemon's
 * disk, and the log outlives any particular one — a database moved to another
 * machine, or an upload root an operator changed, would leave every historical
 * attachment pointing at nothing. A client rebuilds the download URL from
 * `(sessionId, uploadId)`, which are the two things that do not move.
 */
export interface PromptAttachmentRef extends StoredFileRef {
  /**
   * Whether the agent was sent the bytes, or only a link to them.
   *
   * A **decision**, taken synchronously from `(mime, bytes, acceptsImages)`
   * before this event is appended, and the same decision `blocksFor` builds the
   * content blocks from — so the two cannot disagree. Deliberately not an
   * *observation* of the read that follows: observing it would need an await
   * before the append, and the emit path never awaits.
   *
   * It is also the honest home for the agent's image capability. Putting that on
   * `SessionSnapshot` was considered and refused: it only exists while an agent
   * is running, so it would be `boolean | null` on a list that is mostly
   * terminal and restored rows, and nothing acts on it — `resource_link` always
   * works, so the composer's paperclip needs no gate. A result beats a
   * prediction, and this one is durable.
   */
  inlined: boolean;
}

/** A prompt the daemon accepted, recorded so every client sees the same transcript. */
export interface PromptEvent {
  type: "prompt";
  text: string;
  /** `null` rather than absent when there were none — the rule at the top of this file. */
  attachments: PromptAttachmentRef[] | null;
}

/**
 * Where this session ended up running, and anything worth knowing about it.
 *
 * In the log rather than only on the creation response, because the warning that
 * most needs to reach a human — that a worktree branches from a commit, so the
 * uncommitted work sitting in the main checkout is *not* here — would otherwise
 * live only in a 201 body nobody kept. A client attaching an hour later still
 * needs to be told.
 */
export interface WorkspaceEvent {
  type: "workspace";
  mode: SessionWorkspace["mode"];
  root: string;
  requestedCwd: string;
  branch: string | null;
  baseCommit: string | null;
  plainReason: PlainReason | null;
  warnings: { code: string; message: string }[];
}

/** A daemon-level lifecycle transition. Narrative only — the snapshot is authoritative. */
export interface StatusEvent {
  type: "status";
  status: SessionStatus;
  exit: SessionExit | null;
}

export interface TurnEndEvent {
  type: "turn_end";
  stopReason: StopReason;
  usage: Usage | null;
}

/**
 * The agent's memory was reset, and this is where.
 *
 * Emitted when the daemon carries out a `/clear` — see `ManagedSession.clearContext`.
 * Everything above it is still in this log and still readable, because the log is
 * the daemon's rather than the agent's memory; what changed is that the agent
 * past this point knows none of it. Without the marker that reads as a
 * conversation which inexplicably forgot itself.
 *
 * Narrative rather than state, so it lives in the log rather than on the
 * snapshot: it happened once, at a point, and it is exactly the sort of thing
 * somebody scrolling back needs to find *in place*.
 *
 * Both ids are carried because this is the one event that explains why a
 * transcript and an agent disagree about what was said, and answering that later
 * without them means guessing.
 */
export interface ContextClearedEvent {
  type: "context_cleared";
  /** The conversation the agent is on now. */
  agentSessionId: string;
  /** The one the transcript above belongs to. */
  previousAgentSessionId: string;
}

/** A line the agent wrote to stderr. */
export interface AgentLogEvent {
  type: "agent_log";
  line: string;
}

/**
 * A `session/update` variant we do not normalize yet (available commands, usage,
 * plan patches, session metadata). Kept rather than dropped so nothing the agent
 * says disappears silently.
 *
 * `current_mode_update` and `config_option_update` used to land here, which is
 * how mode and effort stayed invisible: the information arrived, was stored, and
 * no client could act on it. They are {@link AgentConfigEvent} now.
 */
export interface OtherUpdateEvent {
  type: "other";
  sessionUpdate: string;
  raw: unknown;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  data: unknown;
}

/**
 * What a session is doing right now.
 *
 * Derived, never stored: see `ManagedSession.status`. `blocked` outranks
 * `running` because a blocked session is the one a human has to act on.
 */
export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "blocked"
  | "stopping"
  | "exited"
  | "failed"
  /**
   * The daemon ended this session, and it is coming back.
   *
   * Terminal — the agent was our child and went with us — but deliberately
   * distinct from `exited`, which means somebody *decided*, and from `failed`,
   * which means it never started. Nobody decided this one, which is why it is
   * the only status the daemon resumes by itself.
   *
   * It covers a clean shutdown as well as a crash, and that took a correction.
   * `daemon_shutdown` used to derive `exited`, so the *ordinary deploy* — much
   * the commonest way a session is interrupted — was indistinguishable from
   * somebody pressing Stop, while this status was reachable only through the
   * hard-kill path that writes `daemon_restarted` at the next boot. So the
   * warn-toned treatment a client gave `interrupted` was on the branch a deploy
   * never took. {@link endedWithDaemon} is the one rule now; `exit.reason` still
   * says which of the two happened.
   */
  | "interrupted";

export type ExitReason =
  | "stopped"
  | "agent_exited"
  | "start_failed"
  | "start_timeout"
  | "daemon_shutdown"
  /**
   * Legacy. Written by no code path, and read by none either.
   *
   * It used to *replace* the caller's reason whenever a kill could not be
   * confirmed, which collapsed `daemon_shutdown` and `stopped` into one value —
   * erasing, on a slow SIGKILL, precisely the distinction the resume rule turns
   * on. `agentConfirmedDead: false` already carries that fact losslessly and
   * beside the reason rather than instead of it. Kept in the union because rows
   * written before that fix still carry it on disk.
   */
  | "agent_kill_failed"
  | "daemon_restarted"
  /**
   * The daemon ended this agent in order to open its conversation again with
   * something different asked of it.
   *
   * Today that is exactly one setting — claude's `ultracode`, which is read when
   * a conversation is opened and has no live channel — and the restart is
   * immediately followed by a resume on the same `agentSessionId`. It is a
   * *daemon* exit rather than a `stopped` for the reason the list below gives:
   * nobody asked for this session to end, and if the resume that follows never
   * lands, the daemon is the one that owes it a retry.
   */
  | "config_changed";

/**
 * The exits that mean the daemon went away rather than that anybody decided
 * anything.
 *
 * One rule, three consumers: the daemon's own resume pass ("which sessions do I
 * bring back"), `SessionStatus` derivation ("which of these is `interrupted`"),
 * and every client that has to answer "may I draw this as ended". Written here,
 * in the shared vocabulary, because a copy in any one of them is a copy that
 * disagrees the day a reason is added.
 *
 * Three members, and each exclusion is a decision rather than an
 * oversight. `stopped` is the one reason that means a human ended it — the whole
 * point. `start_failed`/`start_timeout` never had a conversation to return to.
 * `agent_exited` is the agent quitting under a daemon that is still running,
 * which is not a daemon absence; whether *that* is resumed is a policy question
 * the resume pass answers, not this predicate. `agent_kill_failed` is ambiguous
 * by construction — see its own note above.
 */
export const DAEMON_EXIT_REASONS = ["daemon_restarted", "daemon_shutdown", "config_changed"] as const;

export function endedWithDaemon(exit: { reason: ExitReason } | null | undefined): boolean {
  if (exit === null || exit === undefined) return false;
  return (DAEMON_EXIT_REASONS as readonly ExitReason[]).includes(exit.reason);
}

/**
 * How to signal an agent, and how to recognise it after a restart.
 *
 * Part of the persisted vocabulary rather than a runtime detail, because it is
 * written to disk and read back by a *different* process than the one that wrote
 * it — which is the whole reason it is a union and not a number.
 *
 * The two runtimes do not mean the same thing by "the process". Locally it is a
 * host pid, fenced by `os.uptime()` because pids are recycled across a reboot.
 * In a container it is a process group inside that container's PID namespace: a
 * different number space, which resets whenever the container restarts. Measured
 * 2026-07-30 across `docker restart` — a fresh pid was 309 before and 15 after,
 * while the host's uptime was unchanged, so the host fence is structurally blind
 * to it. Stored in one `agent_pid` column the two would be indistinguishable,
 * and the cost of confusing them is SIGKILL to whatever now holds that number.
 */
export type AgentHandle =
  | { kind: "local"; pid: number }
  | {
      kind: "container";
      containerId: string;
      /** Process group id inside the container. */
      pgid: number;
      /** The container's `State.StartedAt` in ms — the fence for `pgid`. */
      containerStartedAt: number;
    };

export interface SessionExit {
  reason: ExitReason;
  detail: string | null;
  at: number;
  /** Absent on exit records written before the daemon had more than one runtime. */
  agentHandle: AgentHandle | null;
  /**
   * Whether we saw the process actually die, rather than merely asking it to.
   * False here is the difference between "stopped" and "probably orphaned".
   */
  agentConfirmedDead: boolean;
}

/* ------------------------------------------------------------------------- *
 * Where a session runs.
 * ------------------------------------------------------------------------- */

/** Why a session is running directly in the requested directory. */
export type PlainReason = "not_requested" | "not_a_repo" | "unborn_head" | "git_missing";

/**
 * The directory a session owns, whether or not git is involved.
 *
 * One record covers both modes so nothing downstream needs a second code path.
 * It lives here, in the shared vocabulary, rather than in `worktree.ts`, because
 * it is on the snapshot and therefore on the wire — and because `PersistedSession`
 * below has to name it without dragging the git layer into the store.
 *
 * Deliberately closure-free plain data. That is exactly why it survives a restart
 * when a pending permission cannot.
 */
export interface SessionWorkspace {
  mode: "worktree" | "plain";
  /** Where the agent actually runs. For `plain`, identical to `requestedCwd`. */
  root: string;
  /** What the client asked for. Feeds `recentCwds()`, never the worktree path. */
  requestedCwd: string;
  git: {
    /** The main worktree — where `worktree add`/`remove`/`prune` must run. */
    repoRoot: string;
    /** Absolute `$GIT_COMMON_DIR`. The repo's identity, stable across checkouts. */
    commonDir: string;
    branch: string | null;
    /** True only when we created the branch. Gates ever deleting it. */
    createdBranch: boolean;
    /** HEAD at creation, resolved to a sha. The diff base. Set even when `plain`. */
    baseCommit: string;
  } | null;
  plainReason: PlainReason | null;
  createdAt: number;
}

/* ------------------------------------------------------------------------- *
 * The log: sequencing, bounded storage, subscription.
 * ------------------------------------------------------------------------- */

/** An event with its place in the session's total order. This is the wire shape. */
export interface StoredEvent {
  readonly seq: number;
  readonly ts: number;
  readonly event: SessionEvent;
}

export interface EventStoreStats {
  /** Lowest seq still retained; 0 when nothing is. Read `oldestAvailable` instead. */
  firstSeq: number;
  /** Highest seq ever assigned. Survives eviction — it is the resume cursor. */
  lastSeq: number;
  count: number;
  dropped: number;
  approxBytes: number;
}

/**
 * The lowest seq a reader can still be served, whether or not any row survives.
 *
 * `firstSeq` alone is not enough: it is 0 when the table holds nothing for this
 * session, and `firstSeq - 1` is then -1, so every gap predicate written against
 * it silently answers "no gap". That state is reachable two ways — every insert
 * failing (a full disk burns seqs and stores nothing), and a `remove()` that
 * deleted the events and then threw before the session row — and in both the log
 * really has lost everything up to `lastSeq`. Answering `lastSeq + 1` there says
 * exactly that, and keeps `gap` true for the one client that needs to hear it:
 * the one reconnecting with a cursor it can no longer be caught up from.
 *
 * Lives here, in the shared vocabulary, because three separate places have to
 * agree on it: the gap predicate in `server.ts`, the `firstSeq` reported on the
 * wire by `hello` and `GET /sessions/:id/events`, and the `firstSeq` carried on
 * the snapshot by `registry.ts`. The snapshot used to report the raw value, so a
 * client comparing the two disagreed with the daemon about the same session — and
 * the browser's "load earlier history" button, which reads the snapshot, offered
 * to page a log that had nothing left in it.
 */
export function oldestAvailable(stats: { firstSeq: number; lastSeq: number; count: number }): number {
  return stats.count > 0 ? stats.firstSeq : stats.lastSeq + 1;
}

/**
 * Storage only. Subscription lives in `SessionLog`, and `server.ts` never names
 * this type — which is the mechanical reason swapping in SQLite cannot reach it.
 *
 * Deliberately synchronous, `read` included. Node's SQLite bindings are
 * synchronous, so an async store buys nothing and costs a great deal: a
 * synchronous `read` lets a client attach inside one uninterruptible block, which
 * is what makes gap-free resume true by construction rather than by argument.
 */
export interface EventStore {
  /**
   * Assigns the next seq and records the event.
   *
   * MUST NOT throw. This runs inside the agent's event path, and an exception
   * here would unwind the turn pump — aborting the agent mid-task to report a
   * bookkeeping fault. Implementations degrade instead.
   */
  append(sessionId: string, event: SessionEvent): StoredEvent;
  /** Events with seq > since, ascending, bounded by both `limit` and `maxBytes`. */
  read(sessionId: string, since: number, limit: number, maxBytes: number): StoredEvent[];
  stats(sessionId: string): EventStoreStats;
  /** Forget a session entirely. */
  drop(sessionId: string): void;
}

/* ------------------------------------------------------------------------- *
 * Session metadata: what has to outlive the process.
 * ------------------------------------------------------------------------- */

/**
 * A session as it survives a restart.
 *
 * `SessionSnapshot` is the live view and this is the seed it is rebuilt from.
 * They differ on purpose: this carries private bookkeeping a client has no
 * business seeing (`turnCounter`, the permission-id salt) and omits everything
 * that only means something while an agent is alive.
 */
export interface PersistedSession {
  id: string;
  agent: AgentId;
  createdAt: number;
  workspace: SessionWorkspace;
  /** The agent's own session id. The handle `session/resume` is given. */
  agentSessionId: string | null;
  /** Last known agent, so a crashed daemon's orphans can be reaped on the next boot. */
  agentHandle: AgentHandle | null;
  status: SessionStatus;
  exit: SessionExit | null;
  turnCounter: number;
  lastEventAt: number | null;
  /**
   * Persisted so `looksLikeOurs` still recognises its own ids after a restart.
   *
   * One counter and one salt for *both* kinds of parked question — `perm-N-salt`
   * and `elic-N-salt` — because the question they answer ("is this id from this
   * session's this life") is identical and the prefix already separates the two
   * spaces. A second pair would have cost a second persisted column, i.e. a
   * `migrate()` ALTER and the `SCHEMA_VERSION` argument reopened, to buy gaps in
   * each kind's numbering that nothing reads as a count.
   *
   * The SQL columns are still `perm_seq`/`perm_salt`: SQLite cannot rename a
   * column without rewriting the table, and `sessions` holds every transcript on
   * disk. That is the same trade `owner_subject` is left dead for.
   */
  askSeq: number;
  askSalt: string;
  /**
   * What somebody chose about ultracode, and `null` where nobody has.
   *
   * Three-valued on disk as well as here — see the column in `schema.sql`. A
   * `null` is not a missing value to be filled in with `false`: it is the state
   * where the machine's own setting decides, which is where every session starts.
   */
  ultracode: boolean | null;
  /**
   * Why the daemon permanently stopped trying to bring this session back, if it
   * has — and `null` for every session where trying again is still worthwhile.
   *
   * The single exception to retry state living in memory, and the reason it is
   * an exception is that the fact is about the *agent's* disk rather than about
   * an attempt of ours: when it answers `resourceNotFound` for a session id, no
   * restart on this side changes what it holds. Everything else — a timeout, an
   * unreachable mount, an agent that is not signed in — is deliberately
   * forgotten across a restart, because a restart is new information.
   *
   * Typed as a string rather than the union so this file does not have to know
   * the registry's vocabulary; the registry validates on the way back in.
   */
  resumeGaveUp: string | null;
  /**
   * Monotonic floors for the event store.
   *
   * A session whose events were pruned would otherwise restart its sequence at 1,
   * and a client resuming from a cursor it already holds would be handed *different
   * events under numbers it has already seen*. These keep the sequence monotonic
   * for the life of the session id, which is what every cursor on the wire assumes.
   */
  lastSeq: number;
  dropped: number;
  /**
   * What this session is called, or `null` for "never named".
   *
   * Deliberately never `""`: a client has to be able to tell "nobody has named
   * this" from "somebody named it nothing", because the first renders a fallback
   * built from the working directory and the second would render an empty header.
   *
   * Written once from the first prompt, and overwritten only by an explicit
   * rename — which then wins for ever, because the derivation is guarded on this
   * being `null`. Clearing it back to `null` lets the next prompt re-derive.
   */
  title: string | null;
  /**
   * Kept at the top of the list, and never dropped by a `?limit=` cut.
   *
   * A preference, not a state: it outranks liveness but never outranks a pending
   * permission, because a pin is a bookmark and a blocked session is a person
   * being waited on.
   */
  pinned: boolean;
}

export interface SessionStore {
  /**
   * Idempotent upsert.
   *
   * MUST NOT throw, for the same reason `EventStore.append` must not: this runs
   * from `touchSafe()`, on the agent's state-change path, where a bookkeeping
   * fault must never unwind a turn.
   */
  put(row: PersistedSession): void;
  /** Oldest first, matching `SessionRegistry.list()`. */
  list(): PersistedSession[];
  /** Forget a session and everything it logged. */
  remove(id: string): void;
}

export interface MemoryEventStoreOptions {
  maxEventsPerSession?: number;
  maxBytesPerSession?: number;
  /** Per-event ceiling. A single huge diff must not blow the per-session bound. */
  maxEventBytes?: number;
}

/**
 * **A session's log is never truncated.** No default bound, in either store.
 *
 * It was 5000 events / 8 MiB per session, evicting a *prefix* — and what that
 * means in practice was measured rather than reasoned about: session
 * `s_a7b154a7` on the development machine reached `dropped: 6144`, so its oldest
 * surviving event was an agent `text` chunk containing the two characters
 * `" for"`. A conversation somebody was still working in had lost its beginning,
 * mid-word, permanently, and the client could not distinguish that from a
 * conversation that started there.
 *
 * There is no bound that makes that acceptable, because the failure is not
 * proportional to the number. Losing the first half of a conversation is not
 * half a loss: the part that says what the work *is* — the prompt, the plan, the
 * constraints somebody typed once — is the part at the top, and it is the part a
 * prefix eviction takes first. A transcript you cannot trust to be whole is one
 * you have to keep a copy of somewhere else, which is the whole product gone.
 *
 * `Infinity` rather than deleting the machinery. `REEMOAT_LOG_EVENTS` and
 * `REEMOAT_LOG_BYTES` still bound it for an operator who wants that, and
 * `daemoncheck` drives eviction with `maxEventsPerSession: 8` — so the path stays
 * exercised rather than becoming code nobody runs. What changed is the default,
 * which is the only thing anybody was actually getting.
 *
 * **What still bounds the database is whole sessions, not parts of one.**
 * `SqliteSessionStore.prune` keeps 7 days / 200 sessions and removes a session
 * *entire*, with its events. That line is deliberate and is the one to hold:
 * a conversation is kept whole or not at all, never trimmed to a suffix.
 *
 * The one thing that still cuts inside a session is `DEFAULT_MAX_EVENT_BYTES`,
 * and it is a different act — `truncateEvent` shortens one oversized event and
 * says so in the text it leaves behind (`…[truncated N bytes]`). Visible, local,
 * and not the removal of anything a person wrote.
 *
 * The consequence for `server.ts` is real and is handled there: the outbound WS
 * queue used to be sized *above* this window so a `since=0` attach could not
 * overflow it, and with no window there is nothing to size above. See
 * `ATTACH_REPLAY_MAX` and the `backlog` lagged reason.
 */
export const DEFAULT_MAX_EVENTS = Number.POSITIVE_INFINITY;
export const DEFAULT_MAX_BYTES = Number.POSITIVE_INFINITY;
export const DEFAULT_MAX_EVENT_BYTES = 128 * 1024;
/** Above this many evicted slots we rebuild the array rather than leak the prefix. */
const COMPACT_THRESHOLD = 1_024;

interface Retained {
  readonly stored: StoredEvent;
  readonly bytes: number;
}

interface SessionState {
  events: Retained[];
  /** Index of the oldest retained event. Eviction advances this, not a shift(). */
  head: number;
  nextSeq: number;
  dropped: number;
  bytes: number;
}

/**
 * A bounded per-session ring.
 *
 * Eviction only ever removes a prefix, so retained seqs stay contiguous and
 * `read` can locate its start by arithmetic instead of scanning.
 */
export class MemoryEventStore implements EventStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;

  constructor(options: MemoryEventStoreOptions = {}) {
    this.maxEvents = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  }

  append(sessionId: string, event: SessionEvent): StoredEvent {
    const state = this.stateFor(sessionId);

    // Truncation happens before the seq is assigned, so the record that enters
    // the log is the one every downstream byte count describes.
    let payload: SessionEvent;
    let bytes: number;
    try {
      payload = truncateEvent(event, this.maxEventBytes);
      bytes = estimateBytes(payload);
    } catch (error) {
      payload = {
        type: "error",
        message: `event could not be recorded: ${describeError(error)}`,
        data: null,
      };
      bytes = 256;
    }

    const stored: StoredEvent = { seq: state.nextSeq, ts: Date.now(), event: payload };
    state.nextSeq += 1;
    state.events.push({ stored, bytes });
    state.bytes += bytes;
    this.evict(state);
    return stored;
  }

  read(sessionId: string, since: number, limit: number, maxBytes: number): StoredEvent[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const first = state.events[state.head];
    if (!first) return [];

    let index = state.head + Math.max(0, since + 1 - first.stored.seq);
    const out: StoredEvent[] = [];
    let bytes = 0;
    while (index < state.events.length && out.length < limit) {
      const retained = state.events[index]!;
      // Always yield at least one event, or a single oversized record would wedge
      // a reader that can never make progress past it.
      if (out.length > 0 && bytes + retained.bytes > maxBytes) break;
      out.push(retained.stored);
      bytes += retained.bytes;
      index += 1;
    }
    return out;
  }

  stats(sessionId: string): EventStoreStats {
    const state = this.sessions.get(sessionId);
    if (!state) return { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
    const count = state.events.length - state.head;
    return {
      firstSeq: count > 0 ? state.events[state.head]!.stored.seq : 0,
      lastSeq: state.nextSeq - 1,
      count,
      dropped: state.dropped,
      approxBytes: state.bytes,
    };
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { events: [], head: 0, nextSeq: 1, dropped: 0, bytes: 0 };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private evict(state: SessionState): void {
    for (;;) {
      const count = state.events.length - state.head;
      if (count <= 1) break;
      if (count <= this.maxEvents && state.bytes <= this.maxBytes) break;
      state.bytes -= state.events[state.head]!.bytes;
      state.head += 1;
      state.dropped += 1;
    }
    if (state.head > COMPACT_THRESHOLD) {
      state.events = state.events.slice(state.head);
      state.head = 0;
    }
  }
}

export type EventListener = (stored: StoredEvent) => void;
/**
 * Told that a listener threw and has been evicted.
 *
 * Optional on the constructor and, for a long time, supplied by nobody — so the
 * one degradation in this daemon that costs a **live WebSocket** every event for
 * the rest of its life was also the one that reported through nothing. The
 * registry passes its own `onWarning` now; `scripts/` is what prints it.
 */
export type ListenerErrorHandler = (listener: EventListener, error: unknown) => void;

/**
 * One session's log: storage plus fan-out.
 *
 * This is the only piece of the store the server sees.
 */
export class SessionLog {
  private readonly listeners = new Set<EventListener>();

  constructor(
    readonly sessionId: string,
    private readonly store: EventStore,
    private readonly onListenerError?: ListenerErrorHandler,
  ) {}

  /**
   * Records an event and publishes it, synchronously and in one block.
   *
   * There is no `await` here, which is what guarantees seq order equals delivery
   * order and that no listener can be registered between an event being numbered
   * and being published.
   *
   * Each listener is guarded because listeners are live connections and real code
   * throws. An unguarded loop would abort on the first failure, so every listener
   * registered *after* the broken one would silently miss that seq — a gap opened
   * by the very mechanism meant to prevent them — and the throw would escape into
   * the agent's event path.
   */
  append(event: SessionEvent): StoredEvent {
    const stored = this.store.append(this.sessionId, event);
    for (const listener of [...this.listeners]) {
      try {
        listener(stored);
      } catch (error) {
        this.listeners.delete(listener);
        this.onListenerError?.(listener, error);
      }
    }
    return stored;
  }

  /** Registration is in effect the moment this returns. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  read(since: number, limit: number, maxBytes: number): StoredEvent[] {
    return this.store.read(this.sessionId, since, limit, maxBytes);
  }

  stats(): EventStoreStats {
    return this.store.stats(this.sessionId);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  drop(): void {
    this.listeners.clear();
    this.store.drop(this.sessionId);
  }
}

/* ------------------------------------------------------------------------- *
 * Size accounting.
 * ------------------------------------------------------------------------- */

const TRUNCATION_NOTE_BYTES = 32;

/**
 * What an optional agent-chosen id costs.
 *
 * Small, and counted anyway: the `tool_call_update` arm's own comment says an
 * unaccounted payload is an event that walks past the per-event cap unnoticed,
 * and that stays true for a field that is usually short rather than becoming
 * false for one.
 */
function idSize(id: string | null): number {
  return id === null ? 0 : id.length;
}

/**
 * What a prompt's attachment list costs.
 *
 * A real term rather than a flat constant, because `tool_call_update` was `192 +
 * title` while carrying two payloads and an unaccounted payload is an event that
 * walks past the per-event cap unnoticed.
 *
 * Bounded by construction: 10 attachments (`MAX_PROMPT_ATTACHMENTS`), 200-byte
 * names (`MAX_UPLOAD_NAME_BYTES`) and 128-byte mimes, so the worst case is about
 * 4.2 KiB against a 128 KiB per-event cap. That arithmetic is the difference
 * between a bound and a hope, which is why it is written down here rather than
 * assumed at the call site.
 */
function attachmentBytes(attachments: PromptAttachmentRef[] | null): number {
  return refBytes(attachments);
}

/** What a list of file references costs on an event. See `attachmentBytes`. */
function refBytes(refs: readonly StoredFileRef[] | null): number {
  if (refs === null) return 0;
  let total = 0;
  for (const ref of refs) {
    total += 96 + ref.uploadId.length + ref.name.length + (ref.mime?.length ?? 0);
  }
  return total;
}

/**
 * Serialized size of an agent-chosen value, assuming the worst when it will not
 * serialize. Exported for `session.ts`'s form projection, which bounds a total
 * rather than a string and so needs the same answer this file's own caps use.
 */
/**
 * Memoised on identity, because the same blob is measured more than once.
 *
 * ⚠ **This is the agent's synchronous emit path, and measuring here means
 * serializing.** There is no way to ask how large a value will be without
 * building the string, so `estimateBytes` materialises the whole of `rawInput`
 * just to discover whether the event fits — and on the branch where it does not,
 * `truncateEvent` calls `shrink`, which calls this **again** on the same value.
 * An oversized tool call was therefore stringified twice per event before it was
 * stored, and `server.ts` re-derives the size per subscriber on top of that.
 *
 * A `WeakMap` keyed on the value collapses all of it to one pass. `rawInput`
 * arrives as a parsed JSON-RPC value and is never mutated afterwards, so its
 * identity is a sound key — the same argument `changeCounts` makes in the web
 * package, and `sizeOfEvent` in its store.
 *
 * Primitives fall through: they cannot key a `WeakMap`, and stringifying one is
 * the cost of a `toString` rather than a walk.
 */
const SIZES = new WeakMap<object, number>();

export function jsonSize(value: unknown): number {
  if (value == null) return 0;
  const memo = typeof value === "object" ? SIZES.get(value as object) : undefined;
  if (memo !== undefined) return memo;
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    // Cyclic or otherwise unserializable. Assume the worst rather than 0, or the
    // bound it feeds becomes fiction.
    size = 4_096;
  }
  if (typeof value === "object") SIZES.set(value as object, size);
  return size;
}

function optionBytes(options: PermissionOptionSummary[]): number {
  let total = 0;
  for (const option of options) total += option.optionId.length + option.name.length + 32;
  return total;
}

/**
 * What a tool call's file list costs.
 *
 * ⚠ **The term this file was missing.** Both tool-call arms charged for a title,
 * a `rawInput` and (on the update) content and images, and neither charged for
 * `locations` — an array of agent-chosen paths, unbounded in both length and
 * element size until `session.ts` grew `MAX_TOOL_LOCATIONS`. An unaccounted
 * payload is an event that walks past the per-event cap unnoticed, which is what
 * the `tool_call_update` arm's own comment says about the two payloads somebody
 * *did* remember. It defeated three bounds at once, because all three read this
 * number rather than the payload: the 128 KiB per-event ceiling, the per-session
 * byte budget (`schema.sql` stores what this returns), and the WS queue's
 * `MAX_QUEUE_BYTES`.
 */
function locationBytes(locations: readonly FileLocation[]): number {
  let total = 0;
  for (const location of locations) total += location.path.length + 24;
  return total;
}

/**
 * Roughly how much heap an event holds.
 *
 * Proportional for every variable-size variant — a flat constant would make both
 * memory bounds decorative. Note `FileChangeEvent.oldText` is null for every file
 * the agent creates, so the null guard is the common case, not the edge case.
 */
export function estimateBytes(event: SessionEvent): number {
  switch (event.type) {
    case "text":
      return 64 + event.text.length;
    case "prompt":
      return 64 + event.text.length + attachmentBytes(event.attachments);
    case "agent_log":
      return 64 + event.line.length;
    // Explicit rather than the 192-byte default, because both fields are
    // agent-chosen strings. `truncateEvent` still has nothing to do with them:
    // a clipped session id names nothing, and this pair is what explains a
    // transcript that disagrees with its agent.
    case "context_cleared":
      return 64 + event.agentSessionId.length + event.previousAgentSessionId.length;
    case "file_change":
      return 128 + event.path.length + event.newText.length + (event.oldText?.length ?? 0);
    case "tool_call":
      // `subagent` is a boolean and lives inside the constant; the parent id and
      // the tool call id are agent-chosen strings and do not. `locations` is the
      // term that was missing — see `locationBytes`.
      return (
        256 +
        event.title.length +
        jsonSize(event.rawInput) +
        locationBytes(event.locations) +
        idSize(event.toolCallId) +
        idSize(event.parentToolCallId)
      );
    case "tool_call_update":
      // This used to be a flat `192 + title` with no payload term at all, which
      // was honest while the event carried no payload. It carries two now, and an
      // unaccounted one is an event that walks past the per-event cap unnoticed —
      // which is exactly what `locations` then did, for as long as this comment
      // stood above a sum that did not include it.
      return (
        192 +
        (event.title?.length ?? 0) +
        jsonSize(event.rawInput) +
        (event.content?.reduce((total, block) => total + block.length + 8, 0) ?? 0) +
        refBytes(event.images) +
        locationBytes(event.locations) +
        idSize(event.toolCallId) +
        idSize(event.parentToolCallId)
      );
    case "other":
      return 128 + event.sessionUpdate.length + jsonSize(event.raw);
    case "error":
      return 256 + event.message.length + jsonSize(event.data);
    case "plan":
      return 128 + event.entries.reduce((total, entry) => total + entry.content.length + 32, 0);
    case "permission_request":
      return 256 + event.title.length + optionBytes(event.options);
    case "permission_resolved":
      return 256 + event.title.length;
    /*
     * Proportional because the message is agent-chosen prose.
     *
     * This pair used to be the *argument* for writing arms out rather than
     * leaning on a `default`, and the hazard it named — a new type charged a flat
     * 192 against the byte budget and never truncated, silently — is now a
     * compile error instead of a comment: neither this switch nor
     * `truncateEvent`'s has a `default` arm any more, so adding a member to
     * `SessionEvent` fails to build in both places until it is accounted for.
     */
    case "elicitation_request":
      return 256 + event.message.length;
    case "elicitation_resolved":
      return (
        256 +
        event.message.length +
        (event.answers?.reduce(
          (total, answer) => total + answer.key.length + answer.label.length + answer.value.length + 32,
          0,
        ) ?? 0)
      );
    case "workspace":
      return (
        256 +
        event.root.length +
        event.requestedCwd.length +
        event.warnings.reduce((total, warning) => total + warning.message.length + 32, 0)
      );
    case "agent_config":
      // A model list is the large part: claude advertises every model it can
      // reach, each with a name and often a description.
      return (
        128 +
        (event.modes?.available.reduce((total, mode) => total + mode.id.length + mode.name.length + 32, 0) ?? 0) +
        event.options.reduce(
          (total, option) =>
            total +
            option.id.length +
            option.name.length +
            (option.description?.length ?? 0) +
            64 +
            option.choices.reduce(
              (sum, choice) => sum + choice.value.length + choice.name.length + (choice.description?.length ?? 0) + 32,
              0,
            ),
          0,
        )
      );
    /*
     * Flat, and explicit rather than a `default` — which is the point of this
     * switch no longer having one.
     *
     * All three are fixed-shape: union literals, numbers, and on
     * `session_started` an `agentInfo` the adapter fills with its own name and
     * version. None carries agent-chosen *prose*, so 192 is an honest constant
     * rather than a placeholder, and `truncateEvent` correspondingly has nothing
     * to cut on any of them.
     *
     * `session_started.modes` is the one to revisit if it ever grows: a mode list
     * is agent-chosen and unbounded in principle, though measured it is six short
     * ids. Left flat deliberately, because widening it is a behaviour change
     * rather than a refactor.
     */
    case "session_started":
    case "status":
    case "turn_end":
      return 192;
  }
}

/**
 * Clips a string to a budget, leaving the loss visible.
 *
 * Exported because `session.ts` bounds tool output before it ever builds an
 * event, and had a byte-identical copy of this plus its own second declaration of
 * `TRUNCATION_NOTE_BYTES`. Two truncation notes in one vocabulary is how a
 * transcript ends up saying the same thing two ways.
 */
export function clip(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const kept = Math.max(budget - TRUNCATION_NOTE_BYTES, 0);
  return `${value.slice(0, kept)}…[truncated ${value.length - kept} bytes]`;
}

function shrink(value: unknown): unknown {
  return { truncated: true, bytes: jsonSize(value) };
}

/**
 * Bound an agent-chosen blob, leaving the loss visible.
 *
 * Same stand-in `truncateEvent` uses, exported because the pending-permission
 * snapshot needs the identical treatment and must not grow a second, subtly
 * different idea of what truncation looks like. A client already has to handle
 * `{truncated: true, bytes}` in `rawInput`; making it handle a different shape
 * elsewhere would be gratuitous.
 */
export function clampBlob(value: unknown, maxBytes: number): unknown {
  if (value === null || value === undefined) return null;
  return jsonSize(value) <= maxBytes ? value : shrink(value);
}

/**
 * Cuts an oversized event down to `maxBytes`.
 *
 * The loss is left visible in the payload — a truncation marker in the string, a
 * `{truncated: true, bytes}` stand-in for a blob — rather than the record simply
 * arriving shorter than it was.
 */
export function truncateEvent(event: SessionEvent, maxBytes: number): SessionEvent {
  if (estimateBytes(event) <= maxBytes) return event;

  switch (event.type) {
    case "text":
      return { ...event, text: clip(event.text, maxBytes) };
    case "prompt": {
      /*
       * Attachments are spread through **untouched**, and the text budget is
       * reduced by what they already spend.
       *
       * Untouched for the reason `parentToolCallId` is: a clipped attachment is
       * not a smaller attachment, it is a reference to a file that cannot be
       * found. That is only safe because every field is bounded *at ingest* —
       * `MAX_PROMPT_ATTACHMENTS` on the route, the name and mime caps in
       * `uploads.ts` — so "bounded by what the client sent" is never the bound.
       *
       * And the budget really has to be reduced: clipping the text to the full
       * `maxBytes` leaves an event whose attachments push it back over, which is
       * exactly the class of miss the `tool_call_update` arm below describes.
       */
      const spent = attachmentBytes(event.attachments);
      return { ...event, text: clip(event.text, Math.max(maxBytes - spent - 64, 512)) };
    }
    case "agent_log":
      return { ...event, line: clip(event.line, maxBytes) };
    /*
     * Two arms that return the event unchanged, which is what `default` below
     * would already do — and that is precisely why they are written.
     *
     * Both are bounded before they get here, in two different places — naming
     * only one sent a reader to a file that has none. The message is clipped at
     * ingest in `session.ts`; each answer is clipped in `registry.ts`'s
     * `settleElicitation` and refused outright over 2048 on the route; and the
     * form they came from is refused past its own caps. So neither can reach the per-event ceiling. And if one somehow did,
     * there is nothing here to cut: a truncated question is an unanswerable
     * question and a truncated answer is a wrong one. Same reasoning as
     * `MAX_PARENT_ID_CHARS` and `MAX_COMMAND_NAME_CHARS` — where shrinking would
     * corrupt, the bound is a refusal upstream. Falling into `default` silently
     * would say the same thing, and an absence is indistinguishable from an
     * oversight.
     */
    case "elicitation_request":
    case "elicitation_resolved":
      return event;
    case "file_change": {
      const half = Math.floor(maxBytes / 2);
      return {
        ...event,
        oldText: event.oldText === null ? null : clip(event.oldText, half),
        newText: clip(event.newText, half),
      };
    }
    // `parentToolCallId` is spread through untouched, on both arms, and that is
    // a decision rather than an omission: a clipped tree edge is not a shorter
    // field, it is an id pointing at a call that does not exist — and it would be
    // lost on precisely the largest tool calls, which are the ones most worth
    // attributing. That is only safe because it is bounded *before* it arrives,
    // by `MAX_PARENT_ID_CHARS` in `acp/subagents.ts` — the agent chooses the
    // value, so "bounded by the agent's own id length" was not a bound at all,
    // and an unshrinkable field with no ceiling walks an event past the per-event
    // cap. It is also why a generic `_meta` passthrough was refused: that would
    // have to be shrinkable, and this is the alternative to shrinking.
    //
    // `locations` is cut on both arms, which the spread used to carry through
    // untouched. Unlike `parentToolCallId` there is nothing to preserve: nothing
    // acts on a location, so a shorter list is a smaller answer to the same
    // question. It is bounded at ingest too (`MAX_TOOL_LOCATIONS`); this is the
    // half that keeps one oversized event from staying oversized.
    case "tool_call":
      return {
        ...event,
        title: clip(event.title, maxBytes),
        rawInput: shrink(event.rawInput),
        locations: cutLocations(event.locations),
      };
    case "tool_call_update": {
      // The output is what makes this event large, so it is what gets clipped —
      // and clipped per block rather than dropped, because "the command printed
      // something and here is the start of it" is worth far more than a stand-in
      // saying bytes existed. The arguments take the stand-in, same as a call's.
      const blocks = event.content?.length ?? 0;
      const budget = Math.max(Math.floor(maxBytes / Math.max(blocks, 1)) - 32, 64);
      // `images` is spread through untouched, like a prompt's attachments and for
      // the same reason: a clipped reference is not a smaller image, it is a
      // pointer to a file that cannot be fetched. It is bounded at ingest — the
      // name is minted here and the mime is the agent's declared one — so
      // "bounded by what the agent sent" is never the bound.
      return {
        ...event,
        rawInput: shrink(event.rawInput),
        content: event.content === null ? null : event.content.map((block) => clip(block, budget)),
        locations: cutLocations(event.locations),
      };
    }
    case "other":
      return { ...event, raw: shrink(event.raw) };
    case "error":
      return { ...event, message: clip(event.message, maxBytes), data: shrink(event.data) };
    case "plan": {
      const budget = Math.max(Math.floor(maxBytes / Math.max(event.entries.length, 1)) - 32, 64);
      return {
        ...event,
        entries: event.entries.map((entry) => ({ ...entry, content: clip(entry.content, budget) })),
      };
    }
    case "workspace": {
      // The paths are the identity of the record and are never clipped; only the
      // warning prose is, since that is the only unbounded part.
      const budget = Math.max(Math.floor(maxBytes / Math.max(event.warnings.length, 1)) - 32, 64);
      return {
        ...event,
        warnings: event.warnings.map((warning) => ({ ...warning, message: clip(warning.message, budget) })),
      };
    }
    case "agent_config":
      // Ids, names and current values are the identity of a control and are never
      // clipped — a picker missing a choice would silently offer the agent less
      // than it supports. Only the prose goes, which is the same trade the
      // `workspace` arm above makes for the same reason.
      return {
        ...event,
        options: event.options.map((option) => ({
          ...option,
          description: null,
          choices: option.choices.map((choice) => ({ ...choice, description: null })),
        })),
        modes:
          event.modes === null
            ? null
            : {
                ...event.modes,
                available: event.modes.available.map((mode) => ({ ...mode, description: null })),
              },
      };
    /*
     * A permission, cut where it can be.
     *
     * ⚠ **This arm used to return the event unchanged**, filed beside
     * `context_cleared` under "nothing to cut", on the stated ground that
     * permissions are "already clamped far tighter upstream by `clampBlob`,
     * because they ride the snapshot". Every clause of that was true about the
     * wrong fields: `clampBlob` bounds `rawInput` and `content`, and neither is
     * a field of `PermissionRequestEvent` at all. What the event carries is
     * `title` and `options`, and those were bounded by nothing anywhere — so the
     * one event type whose exemption was written down in the most detail was the
     * one with no upstream bound to point at. A comment asserting a property
     * nothing enforces, one file over from the invariant named for it.
     *
     * They are clamped at ingest now (`MAX_PERMISSION_TITLE_CHARS` and friends in
     * `session.ts`), which makes that sentence true rather than aspirational —
     * and this arm cuts the title anyway, because the ingest cap is what keeps
     * the ordinary event small and this is what catches the one that is not.
     * `optionId` is left alone for `parentToolCallId`'s reason: it round-trips to
     * the agent, so a clipped one is an answer nobody can give.
     */
    case "permission_request":
    case "permission_resolved":
      return { ...event, title: clip(event.title, maxBytes) };
    /*
     * Nothing to cut, stated arm by arm rather than left to a `default` — for
     * exactly the reason the elicitation pair above gives: an absence is
     * indistinguishable from an oversight, and with no `default` here a new
     * event type is a compile error instead of a payload that silently walks
     * past the per-event cap.
     *
     * `context_cleared` carries two agent session ids, and a clipped id names
     * nothing. The last three are fixed-shape — union literals and numbers — and
     * are the same three `estimateBytes` charges a flat 192.
     */
    case "context_cleared":
    case "session_started":
    case "status":
    case "turn_end":
      return event;
  }
}

/**
 * The file list, shortened.
 *
 * Half the ingest cap rather than a fresh number: this only ever runs on an
 * event already over the per-event ceiling, where the list is not what anybody
 * is reading, and a second independent constant would be a second thing to keep
 * in agreement with `MAX_TOOL_LOCATIONS`.
 */
function cutLocations(locations: readonly FileLocation[]): FileLocation[] {
  return locations.slice(0, 32).map((location) => ({ ...location, path: clip(location.path, 256) }));
}
