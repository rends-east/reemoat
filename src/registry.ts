import { randomBytes } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentUnavailableError, type AgentId } from "./acp/agents.js";
import {
  isTerminalAsyncTaskState,
  keptOnDisk,
  outlivingAgent,
  withEarlierAgents,
  type AsyncTaskUsage,
  type BackgroundTask,
} from "./acp/asynctasks.js";
import { BUILTIN_CATALOGUE, type MachineCatalogue, type SystemId } from "./acp/systems.js";
import { resolveCwd } from "./browse.js";
import {
  MemoryEventStore,
  SessionLog,
  clampBlob,
  clip,
  endedWithDaemon,
  type MachineSettingKey,
  isAuthFailure,
  isPersistedGiveUp,
  oldestAvailable,
  type AgentCommands,
  type AgentConfig,
  type AgentStateMemory,
  type AgentConfigOption,
  type AgentHandle,
  type AgentModes,
  type AnswerResolvedBy,
  type ContextUsage,
  type ElicitationAnswer,
  type ElicitationField,
  type ElicitationForm,
  type EventStore,
  type ExitReason,
  type PermissionOptionSummary,
  type PersistedSession,
  type ResumeGiveUp,
  type SessionEvent,
  type SessionExit,
  type SessionStatus,
  type SessionStore,
  type SessionWorkspace,
  type StoredEvent,
  type StoredFileRef,
} from "./events.js";
import { LocalRuntime } from "./runtime/local.js";
import { probeExists } from "./stall.js";
import type { SessionRuntime } from "./runtime/types.js";
import {
  isAuthRequiredMessage,
  isSessionClosed,
  ResumeUnsupportedError,
  Session,
  SessionForgottenError,
  type PendingElicitation,
  type PendingPermission,
  type SessionOptions,
} from "./session.js";
import { inlinesImage, type UploadRow } from "./uploads.js";
import {
  createWorkspace,
  resolveWorktreeRoot,
  DEFAULT_BRANCH_PREFIX,
  type WorkspaceWarning,
} from "./worktree.js";
import { describeError } from "./http.js";

const UNUSED_CONVERSATION_LOOKBACK = 64;
const MAX_LOOKBACK_BYTES = 1024 * 1024;

const START_TIMEOUT_MS = 45_000;
const SHUTDOWN_BUDGET_MS = 20_000;
// Bounded well inside daemon.ts's 25s hard limit once SHUTDOWN_BUDGET_MS is spent.
const SHUTDOWN_SWEEP_MS = 3_000;
const KILL_CONFIRM_MS = 250;

// Exits that may overwrite `parked` despite first-writer-wins: each must record somebody deciding, not merely be newer.
const RELABELS_PARKED: readonly ExitReason[] = ["stopped", "agent_signed_out"];

// Minimum age for eviction at the ceiling: parkable cannot see most backgrounded work (Q7.113). Not IDLE_PARK_MS (Q2.223).
const CEILING_PARK_FLOOR_MS = 2 * 60_000;

/** Caps agents resident at once, enforced by parking on wake; only create() refuses (429). REEMOAT_MAX_LIVE_SESSIONS moves it. */
export const MAX_LIVE_SESSIONS = 64;

/** Quiet time before an agent is released (Q2.224). REEMOAT_IDLE_PARK_MINUTES moves it; 0 disables. */
export const IDLE_PARK_MS = 30 * 60_000;

export const IDLE_PARK_SWEEP_MS = 60_000;

/** Agent silence after which a turn is abandoned locally; errs large, since ending a live turn is unrecoverable. REEMOAT_TURN_SILENCE_MINUTES moves it; 0 disables. */
export const TURN_SILENCE_MS = 3 * 60 * 60_000;

export const MAX_IDLE_RELEASE_MINUTES = 7 * 24 * 60;

export interface MachineSettingsPort {
  read(key: MachineSettingKey): string | null;
  write(key: MachineSettingKey, value: string): void;
}

export interface MachineSettingsView {
  idleReleaseMinutes: number;
}

export const SESSION_CREATE_BURST = 16;

export const SESSION_CREATE_REFILL_MS = 120_000;

export type SessionLimitReason = "too_many_sessions" | "session_rate_limited";

/** Answered 429; `retryAfterSeconds` is 0 for the live cap, whose end nobody can predict. */
export class SessionLimitError extends Error {
  constructor(
    readonly reason: SessionLimitReason,
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionLimitError";
  }
}

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const MAX_PERMISSION_BLOB_BYTES = 8 * 1024;

const ELICITATION_CANCELLED: acp.CreateElicitationResponse = { action: "cancel" };

// Caps only the logged copy; the agent gets the answer verbatim, and over-long ones are refused at the route.
const MAX_ELICITATION_ANSWER_CHARS = 2_048;

/** Every check for a waiting human goes through this; daemoncheck pins it against status "blocked". */
export function awaitingHuman(session: SessionSnapshot): boolean {
  return session.pendingPermissions.length + session.pendingElicitations.length > 0;
}

export function usageWorthAnnouncing(before: ContextUsage, after: ContextUsage): boolean {
  if (before.size !== after.size) return true;
  if (before.cost?.amount !== after.cost?.amount) return true;
  if (before.cost?.currency !== after.cost?.currency) return true;
  if (after.size <= 0) return before.used !== after.used;
  return Math.round((before.used / before.size) * 100) !== Math.round((after.used / after.size) * 100);
}

export type ResumeTrigger = "boot" | "prompt";

export const MAX_RESUME_ATTEMPTS = 3;
export const RESUME_CONCURRENCY = 2;
export const RESUME_RETRY_MIN_MS = 2_000;
export const RESUME_RETRY_MAX_MS = 60_000;

/** No default arm: a new ExitReason must be a compile error here, not a silent false. */
export function autoResumable(
  exit: SessionExit | null,
  agentSessionId: string | null,
  trigger: ResumeTrigger,
): boolean {
  if (exit === null || agentSessionId === null) return false;
  switch (exit.reason) {
    case "daemon_shutdown":
    case "daemon_restarted":
    case "config_changed":
      return true;
    case "agent_exited":
      return trigger === "prompt";
    // Prompt only: a boot pass must not start agents that cannot authenticate.
    case "agent_signed_out":
      return trigger === "prompt";
    // Never at boot, or parking gives the memory straight back; a prompt is the only way back.
    case "parked":
      return trigger === "prompt";
    case "stopped":
      return trigger === "prompt";
    case "start_failed":
    case "start_timeout":
    // An unconfirmed kill may leave the old agent on the conversation file; two agents on one file is worse than a refusal.
    case "agent_kill_failed":
      return false;
  }
}

/** autoResumable's prompt column for a bare reason; call it, never a second switch. */
export function revivableByPrompt(reason: ExitReason, agentSessionId: string | null): boolean {
  return autoResumable(
    { reason, detail: null, at: 0, agentHandle: null, agentConfirmedDead: true },
    agentSessionId,
    "prompt",
  );
}

// Refused whole, never clipped: a shorter choice list would make valid values answer invalid_value.
const MAX_AGENT_STATE_BYTES = 64 * 1024;

/** Reduced from the raw agentConfigState, never the composed snapshot; only unselected choices lose their descriptions. */
export function reduceAgentState(
  config: AgentConfig,
  commands: AgentCommands,
  tasks: readonly BackgroundTask[] = [],
): AgentStateMemory | null {
  // Bounded apart, so a long task list can never cost the controls their memory (Q2.234).
  const kept = keptOnDisk(tasks);
  const controls = reduceControls(config, commands);
  if (kept.length === 0) return controls;
  return {
    ...(controls ?? { config: { modes: null, options: [] }, commands: { commands: [], dropped: 0 } }),
    tasks: kept,
  };
}

function reduceControls(config: AgentConfig, commands: AgentCommands): AgentStateMemory | null {
  // Nothing to remember is null: a stored empty pair makes restore tell clients to fetch an empty list.
  if (config.options.length === 0 && commands.commands.length === 0) return null;
  const reduced: AgentStateMemory = {
    config: {
      modes: config.modes,
      options: config.options.map((option) => ({
        ...option,
        choices: option.choices.map((choice) =>
          choice.value === option.value ? choice : { ...choice, description: null },
        ),
      })),
    },
    commands,
  };
  if (JSON.stringify(reduced).length > MAX_AGENT_STATE_BYTES) return null;
  return reduced;
}

export function resumeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(RESUME_RETRY_MIN_MS * 2 ** Math.max(attempt - 1, 0), RESUME_RETRY_MAX_MS);
  return Math.floor(random() * capped);
}

/** One vocabulary for the route and the boot pass: 409 means it cannot work, 5xx that it did not this time. */
export function describeResumeFailure(error: unknown): {
  code: string;
  status: 409 | 502 | 503 | 504;
  message: string;
} {
  const message = describeError(error);
  if (error instanceof ResumeUnavailableError) return { code: error.reason, status: 409, message };
  if (error instanceof SessionForgottenError) return { code: "agent_forgot_session", status: 409, message };
  if (error instanceof ResumeUnsupportedError) return { code: "resume_unsupported", status: 409, message };
  if (error instanceof AgentUnavailableError) return { code: "agent_unavailable", status: 503, message };
  if (error instanceof StartTimeoutError) return { code: "agent_start_timeout", status: 504, message };
  if (isAuthRequiredMessage(message)) {
    return { code: "agent_auth_required", status: 502, message };
  }
  return { code: "agent_launch_failed", status: 502, message };
}

export function sameCommands(before: AgentCommands, after: AgentCommands): boolean {
  if (before.dropped !== after.dropped) return false;
  if (before.commands.length !== after.commands.length) return false;
  return before.commands.every((command, index) => {
    const other = after.commands[index];
    return (
      other !== undefined &&
      command.name === other.name &&
      command.description === other.description &&
      command.hint === other.hint
    );
  });
}

/** usage.durationMs is deliberately not compared: nothing draws it, and a frame changing only it would fan out to every client. */
export function sameBackgroundTasks(
  before: readonly BackgroundTask[],
  after: readonly BackgroundTask[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((task, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      task.id === other.id &&
      task.name === other.name &&
      task.taskType === other.taskType &&
      task.description === other.description &&
      task.state === other.state &&
      task.summary === other.summary &&
      task.lastToolName === other.lastToolName &&
      task.canStop === other.canStop &&
      task.showInTranscript === other.showInTranscript &&
      task.outputFilePath === other.outputFilePath &&
      task.toolCallId === other.toolCallId &&
      task.startedAt === other.startedAt &&
      task.endedAt === other.endedAt &&
      sameTaskUsage(task.usage, other.usage)
    );
  });
}

function sameTaskUsage(before: AsyncTaskUsage | null, after: AsyncTaskUsage | null): boolean {
  if (before === null || after === null) return before === after;
  return before.totalTokens === after.totalTokens && before.toolUses === after.toolUses;
}

export function dedupeAliasChoices(option: AgentConfigOption): AgentConfigOption {
  const lastByDescription = new Map<string, string>();
  const lastByName = new Map<string, string>();
  for (const choice of option.choices) {
    const value = String(choice.value);
    const description = choice.description?.trim();
    if (description !== undefined && description.length > 0) lastByDescription.set(description, value);
    const name = choice.name.trim();
    if (name.length > 0 && !PLACEHOLDER_CHOICE_VALUES.has(value)) lastByName.set(name, value);
  }

  const aliasOf = new Map<string, string>();
  for (const choice of option.choices) {
    // Only a placeholder is ever removed: matching descriptions is a heuristic over untrusted agent output.
    const value = String(choice.value);
    if (!PLACEHOLDER_CHOICE_VALUES.has(value)) continue;
    const description = choice.description?.trim();
    if (description === undefined || description.length === 0) continue;
    const byDescription = lastByDescription.get(description);
    const keeper = byDescription !== undefined && byDescription !== value ? byDescription : lastByName.get(description);
    if (keeper !== undefined) aliasOf.set(value, keeper);
  }
  if (aliasOf.size === 0) return option;

  const selected = typeof option.value === "string" ? (aliasOf.get(option.value) ?? option.value) : option.value;
  return {
    ...option,
    value: selected,
    choices: option.choices.filter((choice) => !aliasOf.has(String(choice.value))),
  };
}

/** Ours, not the agent's: setConfigOption intercepts it, so it never reaches the agent. */
export const ULTRACODE_CHOICE = "ultracode";

const XHIGH_CHOICE = "xhigh";

export function ultracodeOptionId(config: AgentConfig, agent: AgentId): string | null {
  if (agent !== "claude") return null;
  const option = config.options.find((candidate) => candidate.category === "thought_level");
  if (option === undefined || option.kind !== "select") return null;
  if (!option.choices.some((choice) => choice.value === XHIGH_CHOICE)) return null;
  if (option.choices.some((choice) => choice.value === ULTRACODE_CHOICE)) return null;
  return option.id;
}

/** Applied to the snapshot only, never to the state setConfigOption validates against. */
export function withUltracode(config: AgentConfig, agent: AgentId, on: boolean): AgentConfig {
  const optionId = ultracodeOptionId(config, agent);
  if (optionId === null) return config;
  return {
    ...config,
    options: config.options.map((option) =>
      option.id !== optionId
        ? option
        : {
            ...option,
            // Ours: claude publishes effort=default while ultracode is on, which would leave the row unticked.
            value: on ? ULTRACODE_CHOICE : option.value,
            choices: [
              ...option.choices,
              {
                value: ULTRACODE_CHOICE,
                name: "Ultracode",
                description: "Highest effort, and every turn planned as a workflow of subagents",
                group: null,
              },
            ],
          },
    ),
  };
}

function snapshotConfig(config: AgentConfig, namespace: string | null, full = false): AgentConfig {
  return {
    modes:
      config.modes === null
        ? null
        : {
            current: config.modes.current,
            available: config.modes.available.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: null,
            })),
          },
    options: config.options
      .map(dedupeAliasChoices)
      .map((option) => narrowToSystem(option, namespace))
      .map((option) => (full ? option : clipChoices(option)))
      .map((option) => ({
      ...option,
      description: clipChoiceDescription(option.description),
      choices: option.choices.map((choice) => ({
        ...choice,
        // The selected choice keeps its prose: for claude's Default (recommended) it is the only thing naming the model.
        description:
          choice.value === option.value ? clipChoiceDescription(choice.description) : null,
      })),
    })),
  };
}

/** Narrowed by the pairing's namespace, never the current value's, and the selected choice is never removed (Q2.216). */
export function narrowToSystem(option: AgentConfigOption, namespace: string | null): AgentConfigOption {
  if (namespace === null || option.category !== "model") return option;
  const kept = option.choices.filter(
    (choice) => choice.value === option.value || choice.value.startsWith(namespace),
  );
  return kept.length === option.choices.length ? option : { ...option, choices: kept };
}

const MAX_CHOICE_DESCRIPTION_CHARS = 120;

// The selected choice is always kept; truncated says the rest is on GET /sessions/:id.
const MAX_SNAPSHOT_CHOICES = 40;

function clipChoices(option: AgentConfigOption): AgentConfigOption {
  if (option.choices.length <= MAX_SNAPSHOT_CHOICES) return option;
  const head = option.choices.slice(0, MAX_SNAPSHOT_CHOICES);
  if (!head.some((choice) => choice.value === option.value)) {
    const selected = option.choices.find((choice) => choice.value === option.value);
    if (selected !== undefined) head[head.length - 1] = selected;
  }
  return { ...option, choices: head, truncated: true };
}

function clipChoiceDescription(description: string | null): string | null {
  if (description === null) return null;
  const trimmed = description.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_CHOICE_DESCRIPTION_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_CHOICE_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

const PLACEHOLDER_CHOICE_VALUES = new Set(["default"]);

export const MAX_TITLE_CHARS = 120;

const DERIVED_TITLE_CHARS = 60;

export function normalizeTitle(raw: string, limit: number = MAX_TITLE_CHARS): string | null {
  const flattened = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const collapsed = flattened.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

export function deriveSessionTitle(prompt: string): string | null {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return null;
  const normalized = normalizeTitle(firstLine, DERIVED_TITLE_CHARS * 4);
  if (normalized === null) return null;
  if (normalized.length <= DERIVED_TITLE_CHARS) return normalized;
  const cut = normalized.slice(0, DERIVED_TITLE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  const body = space >= DERIVED_TITLE_CHARS - 13 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

export interface PendingPermissionSnapshot {
  permissionId: string;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  raisedAt: number;
  /** Carried here because kimi's tool_call event has rawInput null; both may be the truncated stand-in. */
  rawInput: unknown;
  content: unknown;
  /** Raised with no turn held, where claude cannot restart a plan into a cleared context (Q2.232). */
  outOfTurn: boolean;
}

export interface PendingElicitationSnapshot {
  elicitationId: string;
  toolCallId: string | null;
  /** The agent's prompt, clipped at ingest by clipElicitationMessage in session.ts. */
  message: string;
  fieldCount: number;
  raisedAt: number;
}

export const MAX_RESUME_ERROR_CODE_CHARS = 64;
export const MAX_RESUME_ERROR_MESSAGE_CHARS = 512;

export const MAX_EXIT_DETAIL_CHARS = MAX_RESUME_ERROR_MESSAGE_CHARS;

/** Absent means an older daemon that does not resume: a client reads that as waiting, never failed. */
export interface SessionResumeState {
  state: "waiting" | "running" | "failed";
  attempts: number;
  error: { code: string; message: string } | null;
  at: number;
}

/** Only forgotten persists: no restart changes what is on the agent's disk. */
export function resumeGiveUpPersists(reason: ResumeGiveUp): boolean {
  return reason === "forgotten";
}

export interface SessionSnapshot {
  id: string;
  agent: AgentId;
  /** An id only: the preset's name, system and model are editable, so a copy here would go stale. */
  customAgent: string | null;
  /** Where the agent runs. Always equal to `workspace.root`. */
  cwd: string;
  workspace: SessionWorkspace;
  status: SessionStatus;
  agentSessionId: string | null;
  agentHandle: AgentHandle | null;
  turn: number | null;
  turnStartedAt: number | null;
  /** When the agent began working with no turn held, or null; set only for an agent that marks where a cycle ends (Q2.233). */
  unpromptedSince: number | null;
  /** Also set by a cancel with no turn held, and cleared then when the unprompted work ends. */
  cancelRequestedAt: number | null;
  /** Not guaranteed empty on a steerable agent: a failed steer falls through to the queue. */
  queuedPrompts: QueuedPrompt[];
  /** Empty for ever on an agent that does not report; read reportsBackgroundTasks before drawing it. */
  backgroundTasks: BackgroundTask[];
  reportsBackgroundTasks: boolean;
  midTurnDelivery: "steer" | "queue" | null;
  lastEventAt: number | null;
  createdAt: number;
  agentConfig: AgentConfig;
  /** The list itself is served by GET /sessions/:id/commands; clients refetch on any change, since a restart resets this to 0. */
  commandsRevision: number;
  title: string | null;
  pinned: boolean;
  /** A position clock in milliseconds; null means createdAt. */
  rank: number | null;
  /** null means cannot tell, never 0%. */
  contextUsage: ContextUsage | null;
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  pendingPermissions: PendingPermissionSnapshot[];
  /** Questions the agent is waiting on. Read through `awaitingHuman`, not directly. */
  pendingElicitations: PendingElicitationSnapshot[];
  exit: SessionExit | null;
  resume?: SessionResumeState;
  /** Set only by fitSnapshotFrame on a reduced socket frame; absent means whole. */
  reduced?: SnapshotReduction;
}

export interface SnapshotReduction {
  pendingPermissions: number;
  pendingElicitations: number;
  blobs: boolean;
}

export type DecisionWord = "allow" | "allow_always" | "reject" | "reject_always";
export type PermissionAnswer = { optionId: string } | { decision: DecisionWord } | { cancel: true };

export type PermissionResult =
  | {
      kind: "ok";
      permissionId: string;
      outcome: "selected" | "cancelled";
      optionId: string | null;
      seq: number | null;
      delivered: "sent" | "agent_gone";
    }
  | {
      kind: "already_answered";
      permissionId: string;
      outcome: "selected" | "cancelled";
      optionId: string | null;
      at: number;
      by: AnswerResolvedBy;
    }
  | { kind: "expired"; permissionId: string }
  | { kind: "not_found" }
  | { kind: "invalid_option"; options: PermissionOptionSummary[] }
  | { kind: "no_matching_option"; options: PermissionOptionSummary[] };

/** decline lets the turn carry on and cancel kills the tool call: different acts, both kept. */
export type ElicitationAnswerBody =
  | { content: Record<string, ElicitationContentValue> }
  | { decline: true }
  | { cancel: true };

export type ElicitationContentValue = string | number | boolean | string[];

export interface ElicitationProblem {
  key: string;
  code:
    | "unknown_field"
    | "missing"
    | "wrong_type"
    | "not_an_option"
    | "too_short"
    | "too_long"
    | "too_small"
    | "too_large"
    | "too_few"
    | "too_many"
    | "duplicate";
  detail: string;
}

export type ElicitationResult =
  | {
      kind: "ok";
      elicitationId: string;
      action: "accept" | "decline" | "cancel";
      seq: number | null;
      delivered: "sent" | "agent_gone";
    }
  | {
      kind: "already_answered";
      elicitationId: string;
      action: "accept" | "decline" | "cancel";
      at: number;
      by: AnswerResolvedBy;
    }
  | { kind: "expired"; elicitationId: string }
  | { kind: "not_found" }
  | { kind: "invalid_content"; problems: ElicitationProblem[]; fields: ElicitationField[] };

/** busy is not a running turn: it is the window in which the agent's session id is being replaced (see clearing). */
export type AgentConfigResult =
  | { kind: "ok"; config: AgentConfig }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "turn_in_flight"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus }
  | { kind: "unknown_option"; options: AgentConfigOption[] }
  | { kind: "invalid_value"; option: AgentConfigOption }
  | { kind: "unknown_mode"; modes: AgentModes | null };

export type PromptResult =
  | { kind: "accepted"; turn: number; seq: number }
  /** Not a refusal: the route goes on to sendMidTurn. busy (a clear or restart in flight) still answers 409 turn_in_flight. */
  | { kind: "turn_in_flight"; status: SessionStatus }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

export type MidTurnResult =
  | { kind: "steered"; turn: number; seq: number }
  | { kind: "queued"; id: string; seq: number; position: number }
  | { kind: "accepted"; turn: number; seq: number }
  | { kind: "queue_full"; limit: number }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

/** Rides the snapshot, never the log: the message is already a prompt event, joined by seq (Q2.42). In memory only (Q2.12). */
export interface QueuedPrompt {
  id: string;
  seq: number;
  at: number;
}

interface QueuedEntry extends QueuedPrompt {
  text: string;
  attachments: readonly UploadRow[];
  /** Acceptance order, taken before the first await of sendMidTurn; never the log seq, which is 0 for a refused append and would sort first. */
  order: number;
}

/** Counts queued and in-flight sends together, so a refused message has written nothing (Q2.218). */
export const MAX_QUEUED_PROMPTS = 8;

export function stoppedBeforeDelivery(count: number): string {
  return count === 1
    ? "the session stopped before this message reached the agent"
    : `the session stopped before ${count} messages reached the agent`;
}

export function clearedWithBackgroundWork(count: number): string {
  return count === 1
    ? "one background task was still running in the conversation this cleared"
    : `${count} background tasks were still running in the conversation this cleared`;
}

export function stoppedWithBackgroundWork(count: number): string {
  return count === 1
    ? "the agent was still running one background task when it was shut down"
    : `the agent was still running ${count} background tasks when it was shut down`;
}

export type ClearResult =
  | { kind: "cleared"; seq: number }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

/** no_turn is a success; settled false means we stopped watching, not a failure. turn is null for work nobody prompted (Q2.233). */
export type CancelResult =
  | { kind: "cancelled"; turn: number | null; settled: boolean }
  | { kind: "no_turn"; status: SessionStatus }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

export type StopTaskResult =
  | { kind: "answered"; stopped: boolean }
  | { kind: "no_task" }
  | { kind: "failed"; detail: string }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

export class StartTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `agent did not start within ${timeoutMs / 1000}s. The session is recorded as ${sessionId}; ` +
        "it will be disposed if the agent turns up late.",
    );
    this.name = "StartTimeoutError";
  }
}

export type ResumeUnavailableReason = "session_live" | "no_agent_session_id";

export class ResumeUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: ResumeUnavailableReason,
  ) {
    super(
      reason === "session_live"
        ? "this session has not ended; stop it before resuming"
        : "this session has no agent session id, so there is nothing to reattach to",
    );
    this.name = "ResumeUnavailableError";
  }
}

interface PendingRecord {
  info: PendingPermissionSnapshot;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

interface ResolutionRecord {
  outcome: "selected" | "cancelled";
  optionId: string | null;
  at: number;
  by: AnswerResolvedBy;
}

interface PendingElicitationRecord {
  info: PendingElicitationSnapshot;
  form: ElicitationForm;
  resolve: (response: acp.CreateElicitationResponse) => void;
}

interface ElicitationResolutionRecord {
  action: "accept" | "decline" | "cancel";
  at: number;
  by: AnswerResolvedBy;
}

export type SessionWatcher = (snapshot: SessionSnapshot) => void;

export interface ManagedSessionInit {
  createdAt?: number;
  agentSessionId?: string | null;
  agentHandle?: AgentHandle | null;
  exit?: SessionExit | null;
  turnCounter?: number;
  lastEventAt?: number | null;
  askSeq?: number;
  askSalt?: string;
  resumeGaveUp?: ResumeGiveUp | null;
  title?: string | null;
  pinned?: boolean;
  rank?: number | null;
  agentState?: AgentStateMemory | null;
  /** null means nobody chose and follows REEMOAT_CLAUDE_ULTRACODE; false outranks it. */
  ultracode?: boolean | null;
}

export interface ManagedSessionOptions {
  sessionStore?: SessionStore | null;
  makeRoomForWake?: () => Promise<void>;
  restore?: ManagedSessionInit;
  runtime?: SessionRuntime;
  uploads?: UploadsPort | null;
  /** A thunk: daemon.ts restores sessions before it reads the environment, so a captured value would be stale. */
  elicitationAllowed?: () => boolean;
  ultracodeDefault?: () => boolean;
  customAgent?: string | null;
  /** Read at launch; null falls back to the bare harness. The harness is returned only to be compared, since agent is immutable. */
  resolveCustomAgent?: (id: string) => { harness: AgentId; system: SystemId; model: string } | null;
  machineCatalogue?: () => MachineCatalogue;
  onWarning?: (detail: string) => void;
}

export interface UploadsPort {
  blocksFor(rows: readonly UploadRow[], caps: { image: boolean }): Promise<acp.ContentBlock[]>;
  markConsumed(sessionId: string, uploadIds: readonly string[]): void;
  /** Synchronous by contract — see {@link SessionOptions.keepImage}. */
  keepAgentImage(sessionId: string, mime: string, data: string): StoredFileRef | null;
}

export class ManagedSession {
  readonly createdAt: number;
  readonly log: SessionLog;

  private session: Session | null = null;
  private startPromise: Promise<Session> | null = null;
  private startAbandoned = false;
  private stopRequested = false;
  // Re-armed by every prompt and spent by onAgentUnusable, so an auth failure restarts the agent once rather than looping.
  private authRestartArmed = true;
  private stopping: Promise<void> | null = null;
  private exitRecord: SessionExit | null = null;
  private resuming: Promise<void> | null = null;
  private quietResume = false;

  private resumeAttempts = 0;
  private lastResumeFailureAt: number | null = null;
  private resumeError: { code: string; message: string } | null = null;
  private resumeGivenUp: ResumeGiveUp | null = null;

  private turn: number | null = null;
  private turnCounter: number;
  private turnStartedAt: number | null = null;
  private cancelRequestedAt: number | null = null;
  // Read by parkable: the queue outlives the turn, so an idle session may still owe a delivery.
  private queuedPrompts: QueuedEntry[] = [];
  private acceptOrder = 0;
  private readonly warn: ((detail: string) => void) | null = null;
  private queueSeq = 0;
  // A reservation held across every await of sendMidTurn; without it concurrent sends all read an empty queue and pass MAX_QUEUED_PROMPTS.
  private midTurnAccepted = 0;
  private lastEventAt: number | null = null;
  // Only agent events move this: wedged must not be reset by the person's own messages, which move lastEventAt.
  private lastAgentEventAt: number | null = null;

  // Survives the parked to agent_signed_out relabel, so sign-in can put an idle-released session back rather than spawn.
  private parkedAtSignOut = false;

  private clearing = false;

  // With clearing, refused at every method that addresses the agent: nothing else may talk to it while either holds.
  private get restarting(): boolean {
    return this.restart !== null;
  }

  // Only setConfigOption and setMode refuse on this: a resume is what a message asks for.
  private get replacingConfig(): boolean {
    return this.clearing || this.restarting || this.resuming !== null;
  }

  /** Resolves at once when there is no restart and never rejects; only the prompt route waits. */
  whenRestarted(): Promise<void> {
    return this.restart?.done ?? Promise.resolve();
  }

  private restart: { readonly config: AgentConfig; readonly done: Promise<void> } | null = null;

  // Serves the restart's captured config over the new conversation's; never assigned into agentConfigState, which validation reads.
  private get snapshotConfigSource(): AgentConfig {
    const held = this.restart?.config ?? null;
    if (held === null || held.options.length === 0) return this.agentConfigState;
    // No live agent yet: report that rather than a memory.
    if (this.agentConfigState.options.length === 0) return this.agentConfigState;
    return held;
  }

  private restoredAgentSessionId: string | null;
  private restoredAgentHandle: AgentHandle | null;

  // Not restored from disk except for a session a message would revive; restoreConfig skips anything the agent withdrew.
  private agentConfigState: AgentConfig = { modes: null, options: [] };
  private unsubscribeConfig: (() => void) | null = null;

  private agentCommandsState: AgentCommands = { commands: [], dropped: 0 };
  private commandsRevisionValue = 0;
  private unsubscribeCommands: (() => void) | null = null;

  private titleValue: string | null;
  private pinnedValue: boolean;
  private rankValue: number | null;

  private ultracodeChoice: boolean | null;
  private readonly ultracodeDefault: () => boolean;

  private contextUsageState: ContextUsage | null = null;
  private unsubscribeUsage: (() => void) | null = null;
  // Read by parkable. An empty list with reportsBackgroundTasksState false means nobody asked.
  private backgroundTasksState: readonly BackgroundTask[] = [];
  // Earlier agents' rows on this conversation, all finished; merged under the live agent's (Q2.234).
  private earlierTasks: readonly BackgroundTask[] = [];
  private reportsBackgroundTasksState = false;
  private unsubscribeBackgroundTasks: (() => void) | null = null;
  // Session's, mirrored like the two above so a stop can drop it without waiting on the agent.
  private unpromptedSinceState: number | null = null;
  private unsubscribeUnprompted: (() => void) | null = null;

  private readonly sessionStore: SessionStore | null;
  private readonly makeRoomForWake: (() => Promise<void>) | null;

  private readonly pending = new Map<string, PendingRecord>();
  // Unbounded on purpose: it dies with the session, and a ring would turn already answered into never existed.
  private readonly resolved = new Map<string, ResolutionRecord>();
  private askSeq: number;
  private readonly askSalt: string;

  private readonly pendingElicitations = new Map<string, PendingElicitationRecord>();
  private readonly resolvedElicitations = new Map<string, ElicitationResolutionRecord>();

  private readonly watchers = new Set<SessionWatcher>();
  private readonly runtime: SessionRuntime;
  private readonly uploads: UploadsPort | null;
  private readonly elicitationAllowed: () => boolean;

  // Called from the agent's emit path, so it must stay synchronous.
  private readonly keepAgentImage = (mime: string, data: string): StoredFileRef | null =>
    this.uploads?.keepAgentImage(this.id, mime, data) ?? null;

  readonly customAgent: string | null;
  private readonly machineCatalogue: () => MachineCatalogue;
  private readonly resolveCustomAgent: (
    id: string,
  ) => { harness: AgentId; system: SystemId; model: string } | null;

  constructor(
    readonly id: string,
    readonly agent: AgentId,
    readonly workspace: SessionWorkspace,
    store: EventStore,
    options: ManagedSessionOptions = {},
  ) {
    this.customAgent = options.customAgent ?? null;
    this.resolveCustomAgent = options.resolveCustomAgent ?? (() => null);
    this.machineCatalogue = options.machineCatalogue ?? (() => BUILTIN_CATALOGUE);
    const onWarning = options.onWarning;
    this.warn = onWarning ?? null;
    this.log = new SessionLog(
      id,
      store,
      onWarning === undefined
        ? undefined
        : (_listener, error) =>
            onWarning(`a stream listener on ${id} threw and was dropped: ${describeError(error)}`),
    );
    this.sessionStore = options.sessionStore ?? null;
    this.makeRoomForWake = options.makeRoomForWake ?? null;
    this.runtime = options.runtime ?? new LocalRuntime();
    this.uploads = options.uploads ?? null;
    this.elicitationAllowed = options.elicitationAllowed ?? (() => true);

    const init = options.restore ?? {};
    this.createdAt = init.createdAt ?? Date.now();
    this.restoredAgentSessionId = init.agentSessionId ?? null;
    this.restoredAgentHandle = init.agentHandle ?? null;
    this.exitRecord = init.exit ?? null;
    this.turnCounter = init.turnCounter ?? 0;
    this.lastEventAt = init.lastEventAt ?? null;
    this.askSeq = init.askSeq ?? 0;
    this.askSalt = init.askSalt ?? randomBytes(2).toString("hex").slice(0, 3);
    this.resumeGivenUp = init.resumeGaveUp ?? null;
    // Before the touchSafe below, or a restored session's first row would drop its name and pin.
    this.titleValue = init.title ?? null;
    this.pinnedValue = init.pinned ?? false;
    this.rankValue = init.rank ?? null;
    // The one live-agent state restored from disk; the revision moves with it, since a client skips the fetch at revision 0.
    if (init.agentState != null) {
      this.agentConfigState = init.agentState.config;
      this.agentCommandsState = init.agentState.commands;
      // A memory of tasks alone holds no list, and 0 is what keeps a client from fetching an empty one.
      if (this.agentConfigState.options.length > 0 || this.agentCommandsState.commands.length > 0) {
        this.commandsRevisionValue = 1;
      }
      this.earlierTasks = this.backgroundTasksState = init.agentState.tasks ?? [];
    }
    this.ultracodeChoice = init.ultracode ?? null;
    this.ultracodeDefault = options.ultracodeDefault ?? (() => false);

    // Write the row before anything can be appended to it: start does not touch before its long await.
    this.touchSafe();
  }

  recordWorkspace(warnings: readonly WorkspaceWarning[]): void {
    this.safeAppend({
      type: "workspace",
      mode: this.workspace.mode,
      root: this.workspace.root,
      requestedCwd: this.workspace.requestedCwd,
      branch: this.workspace.git?.branch ?? null,
      baseCommit: this.workspace.git?.baseCommit ?? null,
      plainReason: this.workspace.plainReason,
      warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    });
    this.touchSafe();
  }

  static restore(
    row: PersistedSession,
    store: EventStore,
    options: Omit<ManagedSessionOptions, "restore"> = {},
  ): ManagedSession {
    return new ManagedSession(row.id, row.agent, row.workspace, store, {
      ...options,
      customAgent: row.customAgent,
      restore: {
        createdAt: row.createdAt,
        agentSessionId: row.agentSessionId,
        agentHandle: row.agentHandle,
        exit: row.exit,
        turnCounter: row.turnCounter,
        lastEventAt: row.lastEventAt,
        askSeq: row.askSeq,
        askSalt: row.askSalt,
        // Validated: an unknown value reads as not given up, which costs one spawn and is the safe direction.
        resumeGaveUp: isPersistedGiveUp(row.resumeGaveUp) ? row.resumeGaveUp : null,
        title: row.title,
        pinned: row.pinned,
        rank: row.rank,
        agentState:
          row.exit !== null && revivableByPrompt(row.exit.reason, row.agentSessionId)
            ? row.agentState
            : null,
        ultracode: row.ultracode,
      },
    });
  }

  get title(): string | null {
    return this.titleValue;
  }

  get pinned(): boolean {
    return this.pinnedValue;
  }

  get rank(): number | null {
    return this.rankValue;
  }

  get cwd(): string {
    return this.workspace.root;
  }

  get requestedCwd(): string {
    return this.workspace.requestedCwd;
  }

  get status(): SessionStatus {
    if (this.exitRecord) {
      // Read through endedWithDaemon, never a second list of reasons.
      if (endedWithDaemon(this.exitRecord)) return "interrupted";
      switch (this.exitRecord.reason) {
        case "start_failed":
        case "start_timeout":
          return "failed";
        // Spelled out: the default arm would answer exited, and nobody stopped a parked session.
        case "parked":
          return "parked";
        default:
          return "exited";
      }
    }
    if (this.stopRequested) return "stopping";
    if (this.awaitingCount > 0) return "blocked";
    if (this.turn !== null) return "running";
    // Running means the agent is working, with or without a turn of ours (Q2.233).
    if (this.unpromptedSinceState !== null) return "running";
    if (this.session === null) return "starting";
    return "idle";
  }

  get terminal(): boolean {
    return this.exitRecord !== null;
  }

  get resumable(): boolean {
    return this.terminal && this.agentSessionId !== null;
  }

  get exit(): SessionExit | null {
    return this.exitRecord;
  }

  get lastActivityAt(): number | null {
    return this.lastEventAt;
  }

  get lastAgentActivityAt(): number | null {
    return this.lastAgentEventAt;
  }

  /** Idle status covers every state parking must not interrupt; the resumeGivenUp clause cannot fire today and is kept on purpose. */
  parkable(now: number, idleMs: number): boolean {
    if (this.status !== "idle") return false;
    // A clear or restart leaves status idle, and releaseOneSlot asks with idleMs 0, so both must refuse here (Q2.7).
    if (this.clearing || this.restarting) return false;
    // Unreachable today, since deliverQueued never leaves an idle session queued; kept so a new early return there cannot strand a message.
    if (this.queuedPrompts.length > 0) return false;
    // Background work the transcript's age cannot see; claude only, blind to backgrounded subagents (Q7.113), unbounded by decision (Q2.228).
    if (this.hasLiveBackgroundWork) return false;
    if (this.agentSessionId === null) return false;
    if (this.resumeGivenUp !== null) return false;
    return now - (this.lastActivityAt ?? this.createdAt) >= idleMs;
  }

  /** Reads status, so blocked (an unanswered approval) is never reaped; a queue is no clause, since ending the turn delivers it. */
  wedged(now: number, silenceMs: number): boolean {
    if (this.turn === null) return false;
    return this.silentFor(now, silenceMs, this.turnStartedAt ?? 0);
  }

  abandonTurn(): boolean {
    return this.session?.abandonTurn() ?? false;
  }

  /** wedged's clock for work nobody prompted, whose end marker an adapter may stop sending (Q2.233). */
  unpromptedGoneQuiet(now: number, silenceMs: number): boolean {
    if (this.turn !== null || this.unpromptedSinceState === null) return false;
    return this.silentFor(now, silenceMs, this.unpromptedSinceState);
  }

  /** Writes nothing: no turn ends, so there is nothing for the log to say. */
  endUnprompted(): void {
    this.session?.endUnprompted();
  }

  private silentFor(now: number, silenceMs: number, since: number): boolean {
    if (silenceMs <= 0) return false;
    if (this.status !== "running") return false;
    if (this.clearing || this.restarting) return false;
    if (this.hasLiveBackgroundWork) return false;
    // The agent's clock, never lastActivityAt, which a person's messages move; floored at the start for fresh work.
    const quietSince = Math.max(this.lastAgentEventAt ?? 0, since);
    return now - quietSince >= silenceMs;
  }

  private get hasLiveBackgroundWork(): boolean {
    return this.backgroundTasksState.some((task) => !isTerminalAsyncTaskState(task.state));
  }

  get resumeAttemptCount(): number {
    return this.resumeAttempts;
  }

  get resumeAbandoned(): ResumeGiveUp | null {
    return this.resumeGivenUp;
  }

  /** The gate on both automatic paths, so a forgotten conversation is not respawned on every boot and every message. */
  get resumeSettled(): boolean {
    if (this.resumeGivenUp === null || !resumeGiveUpPersists(this.resumeGivenUp)) return false;
    // A conversation this daemon opened and never used is not settled, even under a persisted verdict: it is recreatable.
    return !this.conversationKnownEmpty();
  }

  noteResumeFailure(code: string, message: string): number {
    this.resumeAttempts += 1;
    this.lastResumeFailureAt = Date.now();
    this.resumeError = { code, message };
    this.touchSafe();
    return this.resumeAttempts;
  }

  /** Spends no attempt: a missing CLI repeats until the install lands, and the pass after each agent update retries it. */
  deferResume(code: string, message: string): void {
    this.lastResumeFailureAt = Date.now();
    this.resumeError = { code, message };
    this.touchSafe();
  }

  abandonResume(reason: ResumeGiveUp, code: string, message: string): void {
    if (this.resumeGivenUp !== null) return;
    this.resumeGivenUp = reason;
    this.lastResumeFailureAt = Date.now();
    this.resumeError = { code, message };
    this.safeAppend({
      type: "error",
      message: `could not reattach an agent to this session: ${message}`,
      data: { code, reason },
    });
    this.touchSafe();
  }

  get agentSessionId(): string | null {
    return this.session?.sessionId ?? this.restoredAgentSessionId;
  }

  get agentHandle(): AgentHandle | null {
    return this.session?.handle ?? this.restoredAgentHandle;
  }

  // The in-class twin of awaitingHuman, since status runs before a snapshot exists; daemoncheck asserts they agree.
  private get awaitingCount(): number {
    return this.pending.size + this.pendingElicitations.size;
  }

  /** fullConfig (GET /sessions/:id) skips the choice cut; listing (the polled GET /sessions) drops what a poll cannot afford. */
  snapshot(options: { fullConfig?: boolean; listing?: boolean } = {}): SessionSnapshot {
    const stats = this.log.stats();
    return Object.freeze({
      id: this.id,
      agent: this.agent,
      customAgent: this.customAgent,
      cwd: this.cwd,
      workspace: { ...this.workspace, git: this.workspace.git && { ...this.workspace.git } },
      status: this.status,
      agentSessionId: this.agentSessionId,
      agentHandle: this.agentHandle,
      turn: this.turn,
      turnStartedAt: this.turnStartedAt,
      unpromptedSince: this.unpromptedSinceState,
      cancelRequestedAt: this.cancelRequestedAt,
      // Field by field, never a spread: QueuedEntry carries the message body and its uploads.
      queuedPrompts: this.queuedPrompts.map((entry) => ({ id: entry.id, seq: entry.seq, at: entry.at })),
      // The polled read nulls outputFilePath, the largest field and one nothing draws.
      backgroundTasks:
        options.listing === true
          ? this.backgroundTasksState.map((task) => ({ ...task, outputFilePath: null }))
          : [...this.backgroundTasksState],
      reportsBackgroundTasks: this.reportsBackgroundTasksState,
      midTurnDelivery: this.session === null ? null : this.session.supportsSteering ? "steer" : "queue",
      lastEventAt: this.lastEventAt,
      createdAt: this.createdAt,
      title: this.titleValue,
      pinned: this.pinnedValue,
      // Always emitted, null included: a client reads an absent rank as a daemon that cannot store an order.
      rank: this.rankValue,
      contextUsage:
        this.contextUsageState === null
          ? null
          : { ...this.contextUsageState, cost: this.contextUsageState.cost && { ...this.contextUsageState.cost } },
      agentConfig: snapshotConfig(
        withUltracode(this.snapshotConfigSource, this.agent, this.ultracodeWanted),
        this.modelNamespace,
        options.fullConfig === true,
      ),
      commandsRevision: this.commandsRevisionValue,
      // The derived floor, not the raw firstSeq, which is 0 for a log that holds nothing.
      firstSeq: oldestAvailable(stats),
      lastSeq: stats.lastSeq,
      dropped: stats.dropped,
      pendingPermissions: [...this.pending.values()].map((record) => ({
        ...record.info,
        options: [...record.info.options],
      })),
      pendingElicitations: [...this.pendingElicitations.values()].map((record) => ({
        ...record.info,
      })),
      exit: this.exitRecord === null ? null : { ...this.exitRecord },
      ...(this.resumeState === null ? {} : { resume: this.resumeState }),
    });
  }

  private get resumeState(): SessionResumeState | null {
    if (this.resuming !== null) {
      return { state: "running", attempts: this.resumeAttempts, error: null, at: Date.now() };
    }
    if (!this.terminal) return null;
    if (this.resumeGivenUp !== null) {
      return {
        state: "failed",
        attempts: this.resumeAttempts,
        error: this.resumeError && {
          code: this.resumeError.code.slice(0, MAX_RESUME_ERROR_CODE_CHARS),
          message: clip(this.resumeError.message, MAX_RESUME_ERROR_MESSAGE_CHARS),
        },
        at: this.lastResumeFailureAt ?? Date.now(),
      };
    }
    if (this.resumeAttempts === 0 && this.resumeError === null) return null;
    return {
      state: "waiting",
      attempts: this.resumeAttempts,
      error: this.resumeError && {
        code: this.resumeError.code.slice(0, MAX_RESUME_ERROR_CODE_CHARS),
        message: clip(this.resumeError.message, MAX_RESUME_ERROR_MESSAGE_CHARS),
      },
      at: this.lastResumeFailureAt ?? Date.now(),
    };
  }

  async clearContext(text: string): Promise<ClearResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    if (this.turn !== null || this.clearing || this.restarting) return { kind: "busy", status: this.status };
    // The agent is mid-cycle without a turn: clearing would decide that cycle's fate, which is Stop's to decide (Q2.232).
    if (this.unpromptedSinceState !== null || this.awaitingCount > 0) return { kind: "busy", status: this.status };

    const seq = this.safeAppend({ type: "prompt", text, attachments: [] })?.seq ?? 0;
    // Set before the await: nothing else may address the agent while its session id is replaced.
    this.clearing = true;
    this.touchSafe();

    try {
      const moved = await session.clearContext();
      this.restoredAgentSessionId = moved.next;
      // A cleared conversation is a new one, so no earlier agent's work belongs to it.
      this.earlierTasks = [];
      this.applyBackgroundTasks(session.backgroundTasks);
      this.safeAppend({
        type: "context_cleared",
        agentSessionId: moved.next,
        previousAgentSessionId: moved.previous,
      });
      if (moved.abandonedTasks > 0) {
        this.safeAppend({
          type: "error",
          message: clearedWithBackgroundWork(moved.abandonedTasks),
          data: null,
        });
      }
      this.applyAgentConfig(session.agentConfig);
      this.touchSafe();
      return { kind: "cleared", seq };
    } finally {
      this.clearing = false;
      // A message queued before a clear is delivered into the fresh conversation, on purpose.
      this.deliverQueued();
    }
  }

  watch(watcher: SessionWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  private get ultracodeWanted(): boolean {
    return this.ultracodeChoice ?? this.ultracodeDefault();
  }

  private get assembled(): { system?: SystemId; model?: string } {
    if (this.customAgent === null) return {};
    const one = this.resolveCustomAgent(this.customAgent);
    if (one === null) return {};
    // A conversation cannot change vendor underneath itself: agent is immutable, so a re-pointed preset no longer applies.
    if (one.harness !== this.agent) return {};
    return { system: one.system, model: one.model };
  }

  private get modelNamespace(): string | null {
    const system = this.assembled.system;
    if (system === undefined) return null;
    // null rather than a throw: this runs on every poll, and a plugin may have been removed.
    const spec = this.machineCatalogue().system(system);
    if (spec === null) return null;
    return spec.nativeHarness === this.agent ? spec.nativeModelPrefix : null;
  }

  // One bag for all three launch sites, re-read at every launch: an omission at any one of them is silent.
  private get launchOptions(): SessionOptions {
    return {
      agent: this.agent,
      ...this.assembled,
      cwd: this.cwd,
      permissions: this.resolvePermission,
      elicitations: this.elicitationAllowed() ? this.resolveElicitation : null,
      runtime: this.runtime,
      machine: this.machineCatalogue(),
      keepImage: this.keepAgentImage,
      ultracode: this.ultracodeWanted,
    };
  }

  async start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    this.safeAppend({ type: "status", status: "starting", exit: null });
    await this.launch(Session.start(this.launchOptions), timeoutMs);
  }

  private async launch(starting: Promise<Session>, timeoutMs: number): Promise<void> {
    this.startPromise = starting;

    // Never dropped: a late resolve owns a live subprocess. Callbacks check launch identity, since the next armForStart resets startAbandoned.
    starting.then(
      (session) => this.onStarted(starting, session),
      (error: unknown) => this.onStartFailed(starting, error),
    );

    const timeout = Symbol("timeout");
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), timeoutMs);
    });
    const outcome = await Promise.race([
      starting.then(
        () => null,
        (error: unknown) => error ?? new Error("agent failed to start"),
      ),
      expiry,
    ]).finally(() => clearTimeout(timer));

    if (outcome === timeout) {
      this.startAbandoned = true;
      throw new StartTimeoutError(this.id, timeoutMs);
    }
    if (outcome !== null) throw outcome;
  }

  async resume(timeoutMs = START_TIMEOUT_MS, quiet = false): Promise<void> {
    // Memoised like stopping, so a second concurrent request joins the launch instead of answering not_ready.
    if (this.resuming) return this.resuming;
    this.quietResume = quiet;
    this.resuming = this.doResume(timeoutMs, quiet);
    try {
      await this.resuming;
    } finally {
      this.resuming = null;
      this.quietResume = false;
    }
  }

  private onResumed(): void {
    this.resumeAttempts = 0;
    this.lastResumeFailureAt = null;
    this.resumeError = null;
    this.resumeGivenUp = null;
    this.touchSafe();
  }

  private armForStart(): void {
    this.exitRecord = null;
    // Cleared with the exit record, or a later returnToParked would park a session holding a live agent.
    this.parkedAtSignOut = false;
    this.stopRequested = false;
    this.stopping = null;
    this.startAbandoned = false;
    this.startPromise = null;
    this.session = null;
  }

  /** True when nothing has been said: no turn ever ran, or the log tail ends in a clear. claude writes a transcript only with the first turn. */
  private conversationKnownEmpty(): boolean {
    // Not an empty log, which pruning makes; and a clear moves the id but not the counter, so the walk below is still needed.
    if (this.turnCounter === 0) return true;

    const stats = this.log.stats();
    const from = Math.max(0, stats.lastSeq - UNUSED_CONVERSATION_LOOKBACK);
    // Whichever came last wins: a session cleared twice has an older marker with a conversation after it.
    let cleared = false;
    for (const stored of this.log.read(from, UNUSED_CONVERSATION_LOOKBACK + 1, MAX_LOOKBACK_BYTES)) {
      const type = stored.event.type;
      if (type === "context_cleared") cleared = true;
      else if (type === "prompt") cleared = false;
    }
    return cleared;
  }

  private async doResume(timeoutMs: number, quiet: boolean): Promise<void> {
    const agentSessionId = this.agentSessionId;
    if (agentSessionId === null) throw new ResumeUnavailableError(this.id, "no_agent_session_id");
    if (!this.terminal) throw new ResumeUnavailableError(this.id, "session_live");

    // Before armForStart, which makes this session count as live; never refuses.
    // Only when a person is asking: a quiet boot pass at the ceiling would evict sessions it had just resumed.
    if (!quiet) {
      // Re-checked by identity after the await: a stop inside it replaces exitRecord, and stopRequested is already true for a park.
      const before = this.exitRecord;
      await this.makeRoomForWake?.().catch(() => {});
      if (this.exitRecord !== before) throw new ResumeUnavailableError(this.id, "session_live");
    }

    const previousExit = this.exitRecord;
    const wantedConfig = this.agentConfigState;
    this.armForStart();

    if (!quiet) {
      this.safeAppend({ type: "status", status: "starting", exit: null });
    }
    this.touchSafe();

    // An empty conversation is opened, not resumed: claude writes nothing to disk before the first turn, so a resume can only fail.
    const empty = this.conversationKnownEmpty();
    try {
      await this.launch(
        empty
          ? Session.start(this.launchOptions)
          : Session.resume({ ...this.launchOptions, agentSessionId }),
        timeoutMs,
      );
      this.onResumed();
      // Awaited so the first prompt after a wake cannot beat it; restoreConfig swallows refusals and skips withdrawn values.
      await this.session?.restoreConfig(wantedConfig);
    } catch (error) {
      // Put the original exit back, or start_failed would erase daemon_restarted; the session stays retryable.
      if (previousExit) {
        this.exitRecord = previousExit;
        if (!quiet) {
          this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
        }
        this.touchSafe();
      }
      throw error;
    }
  }

  private onStarted(launch: Promise<Session>, session: Session): void {
    // A superseded launch: dispose before assigning this.session, or a prompt could start a turn on an agent about to be discarded.
    if (this.startPromise !== launch) {
      void session.dispose().catch(() => {});
      return;
    }

    this.session = session;
    this.restoredAgentSessionId = session.sessionId;
    this.restoredAgentHandle = session.handle;

    // Must end in dispose, not only a status field, or a live agent is marked exited and its last handle lost.
    void session.exited.then(
      () => this.onAgentGone(session),
      () => this.onAgentGone(session),
    );

    if (this.stopRequested || this.startAbandoned) {
      void session.dispose().catch(() => {});
      return;
    }

    this.unsubscribeConfig?.();
    this.applyAgentConfig(session.agentConfig);
    this.unsubscribeConfig = session.onConfigChanged((config) => {
      // Identity-checked here and below: a late notification from a replaced agent must not overwrite the current one's state.
      if (this.session !== session) return;
      this.applyAgentConfig(config);
    });

    this.unsubscribeUsage?.();
    const initialUsage = session.contextUsage;
    if (initialUsage !== null) this.applyContextUsage(initialUsage);
    this.unsubscribeUsage = session.onUsageChanged((usage) => {
      if (this.session !== session) return;
      this.applyContextUsage(usage);
    });

    // Read once before subscribing: the adapters can publish commands before this line runs.
    this.unsubscribeCommands?.();
    const initialCommands = session.agentCommands;
    if (initialCommands.commands.length > 0) this.applyAgentCommands(initialCommands);
    this.unsubscribeCommands = session.onCommandsChanged((commands) => {
      if (this.session !== session) return;
      this.applyAgentCommands(commands);
    });

    // Unconditional: a stale set surviving a resume would keep parkable refusing for ever.
    this.unsubscribeBackgroundTasks?.();
    this.reportsBackgroundTasksState = session.reportsBackgroundTasks;
    this.applyBackgroundTasks(session.backgroundTasks);
    this.unsubscribeBackgroundTasks = session.onBackgroundTasksChanged((tasks) => {
      if (this.session !== session) return;
      this.applyBackgroundTasks(tasks);
    });

    // Unconditional for the same reason: a previous agent's cycle is not this one's.
    this.unsubscribeUnprompted?.();
    this.unpromptedSinceState = session.unpromptedSince;
    this.unsubscribeUnprompted = session.onUnpromptedChanged((since) => {
      if (this.session !== session) return;
      this.applyUnprompted(since);
    });

    this.safeAppend({ type: "status", status: "idle", exit: null });
    this.startIdleDrain(session);
    this.touchSafe();
  }

  private startIdleDrain(session: Session): void {
    session.drainBetweenTurns((event) => {
      // stopRequested too: doStop never nulls this.session, and teardown can take seconds.
      if (this.session !== session || this.stopRequested) return;

      // agent_log and other are never recorded: out of turn they are an unbounded stream into a log that evicts a prefix.
      if (event.type === "agent_log" || event.type === "other") {
        // Dropped from the log but not from the clock: output still counts as activity for parkable.
        this.lastEventAt = this.lastAgentEventAt = Date.now();
        return;
      }

      try {
        this.record(event);
      } catch {
        // Already degraded inside the store; guarded here so one failed append cannot end the drain.
      }
    });
  }

  private applyAgentConfig(config: AgentConfig): void {
    this.agentConfigState = config;
    this.safeAppend({ type: "agent_config", modes: config.modes, options: config.options });
    this.touchSafe();
  }


  // Gated on the list differing: claude republishes identical lists mid-turn, and each bump makes every client refetch.
  private applyAgentCommands(commands: AgentCommands): void {
    if (sameCommands(this.agentCommandsState, commands)) return;
    this.agentCommandsState = commands;
    this.commandsRevisionValue += 1;
    this.touchSafe();
  }

  get agentCommands(): AgentCommands {
    return this.agentCommandsState;
  }

  get commandsRevision(): number {
    return this.commandsRevisionValue;
  }

  // Assigned on every update; only the fan-out is coalesced, since usage_update fires on nearly every token.
  private applyContextUsage(usage: ContextUsage): void {
    const before = this.contextUsageState;
    this.contextUsageState = usage;
    if (before !== null && !usageWorthAnnouncing(before, usage)) return;
    this.touchSafe();
  }

  // Snapshot-only like cancelRequestedAt: an event per edge would put a row on screen for no act anybody did.
  private applyUnprompted(since: number | null): void {
    this.unpromptedSinceState = since;
    // An out-of-turn cancel is answered by the work ending; a turn's own cancel is pump's to clear.
    if (since === null && this.turn === null) this.cancelRequestedAt = null;
    this.touchSafe();
  }

  // Not logged, since anything recorded moves lastEventAt, which parkable measures; always assigned, fan-out gated.
  private applyBackgroundTasks(tasks: readonly BackgroundTask[]): void {
    const before = this.backgroundTasksState;
    const merged = withEarlierAgents(tasks, this.earlierTasks);
    this.backgroundTasksState = merged;
    if (sameBackgroundTasks(before, merged)) return;
    this.touchSafe();
  }

  /** Allowed on a terminal session: naming a finished session is the point. */
  setMeta(change: { title?: string | null; pinned?: boolean; rank?: number | null }): SessionSnapshot {
    if (change.title !== undefined) {
      this.titleValue = change.title === null ? null : normalizeTitle(change.title);
    }
    if (change.pinned !== undefined) this.pinnedValue = change.pinned;
    if (change.rank !== undefined) this.rankValue = change.rank;
    this.touchSafe();
    return this.snapshot();
  }

  /** A tap on a session a prompt would revive is recorded and applied at resume; it never starts an agent. */
  private get configIsDeferred(): boolean {
    if (this.exitRecord === null) return false;
    return revivableByPrompt(this.exitRecord.reason, this.agentSessionId);
  }

  private recordDeferredConfig(next: AgentConfig): AgentConfigResult {
    this.applyAgentConfig(next);
    return { kind: "ok", config: this.snapshot().agentConfig };
  }

  /** Refuses any control or value the agent did not advertise. */
  async setConfigOption(configId: string, value: string | boolean): Promise<AgentConfigResult> {
    // Before the deferred arm: during a restart configIsDeferred is true, and restoreConfig would overwrite a recorded choice.
    if (this.replacingConfig) return { kind: "busy", status: this.status };
    if (this.configIsDeferred) {
      // Ultracode first: the agent's own options never carry ULTRACODE_CHOICE, so it cannot be validated below; recorded for the wake.
      const deferredUltracodeId = ultracodeOptionId(this.agentConfigState, this.agent);
      if (deferredUltracodeId !== null && configId === deferredUltracodeId) {
        const wanted = value === ULTRACODE_CHOICE;
        if (wanted !== this.ultracodeWanted) {
          this.ultracodeChoice = wanted;
          this.touchSafe();
        }
        if (wanted) return { kind: "ok", config: this.snapshot().agentConfig };
      }
      const option = this.agentConfigState.options.find((candidate) => candidate.id === configId);
      if (option === undefined) return { kind: "unknown_option", options: this.agentConfigState.options };
      if (option.kind === "boolean" && typeof value !== "boolean") return { kind: "invalid_value", option };
      if (option.kind === "select" && (typeof value !== "string" || !option.choices.some((c) => c.value === value))) {
        return { kind: "invalid_value", option };
      }
      return this.recordDeferredConfig({
        modes: this.agentConfigState.modes,
        options: this.agentConfigState.options.map((candidate) =>
          candidate.id === configId ? { ...candidate, value } : candidate,
        ),
      });
    }
    if (this.terminal || this.stopRequested) return { kind: "terminal", status: this.status };
    if (!this.session) return { kind: "not_ready", status: this.status };

    // Both directions restart the agent, since ultracode is read only when a conversation opens; this.session is re-read below because the restart replaces it.
    const ultracodeId = ultracodeOptionId(this.agentConfigState, this.agent);
    if (ultracodeId !== null && configId === ultracodeId) {
      const wanted = value === ULTRACODE_CHOICE;
      if (wanted !== this.ultracodeWanted) {
        // A restart would kill the turn, unprompted work, or a request parked between turns: clearContext's gate (Q2.232).
        if (this.turn !== null || this.unpromptedSinceState !== null || this.awaitingCount > 0) {
          return { kind: "turn_in_flight", status: this.status };
        }
        await this.applyUltracode(wanted);
      }
      if (wanted) return { kind: "ok", config: this.snapshot().agentConfig };
    }

    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };

    const option = this.agentConfigState.options.find((candidate) => candidate.id === configId);
    if (option === undefined) return { kind: "unknown_option", options: this.agentConfigState.options };
    if (option.kind === "boolean" && typeof value !== "boolean") {
      return { kind: "invalid_value", option };
    }
    if (option.kind === "select" && (typeof value !== "string" || !option.choices.some((c) => c.value === value))) {
      return { kind: "invalid_value", option };
    }

    // Not applied here: setConfigOption notifies before it resolves, so applying again would log agent_config twice.
    await session.setConfigOption(configId, value);
    return { kind: "ok", config: this.snapshot().agentConfig };
  }

  /** Written before the restart, so a failed restart still asks for it next time. */
  private async applyUltracode(next: boolean): Promise<void> {
    this.ultracodeChoice = next;
    this.touchSafe();
    if (this.agentSessionId === null) return;
    await this.restartAgent();
  }

  /** Replaces the agent process, keeping the conversation; callers decide whether that is safe. */
  private async restartAgent(): Promise<void> {
    // Captured before the stop resets it. The raw state, never the snapshot's agentConfig, which carries values the agent never published.
    const wanted = this.agentConfigState;

    // Held across stop, resume and restore so the guards answer busy; cleared in finally so a throwing resume cannot wedge the session.
    let finished!: () => void;
    this.restart = {
      config: wanted,
      // Assigned before the first await, so the guard window and whenRestarted's window are the same.
      done: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    try {
      await this.stop("config_changed");
      await this.resume();

      // Awaited so the caller's response snapshot never shows the agent's defaults.
      await this.session?.restoreConfig(wanted).catch(() => {});
    } finally {
      // Announced: the restore may skip options, and clients last saw the held config.
      this.restart = null;
      this.touchSafe();
      // A restart is a state deliverQueued declines in, so leaving it owes the queue a nudge.
      this.deliverQueued();
      // doStop keeps the queue for config_changed, so if no agent came back nothing else would drain it.
      if (this.session === null) this.dropQueuedUndelivered();
      // Resolved last so a waiting prompt sees the corrected state; never rejected, see whenRestarted.
      finished();
    }
  }

  /** False while terminal, working, awaiting a permission, or at another process boundary; a getter so callers can count before acting. */
  get takesCredentialChange(): boolean {
    if (this.terminal || this.stopRequested) return false;
    if (this.session === null || this.agentSessionId === null) return false;
    if (this.turn !== null || this.unpromptedSinceState !== null) return false;
    if (this.awaitingCount > 0) return false;
    return !this.clearing && !this.restarting;
  }

  /** {@link takesCredentialChange}, then the restart. Re-checked, never assumed. */
  async applyCredentialChange(): Promise<void> {
    if (!this.takesCredentialChange) return;
    await this.restartAgent();
  }

  async setMode(modeId: string): Promise<AgentConfigResult> {
    const session = this.session;
    // Before the deferred arm, as in setConfigOption.
    if (this.replacingConfig) return { kind: "busy", status: this.status };
    if (this.configIsDeferred) {
      const option = this.agentConfigState.options.find((candidate) => candidate.category === "mode");
      const known =
        this.agentConfigState.modes?.available.some((mode) => mode.id === modeId) === true ||
        option?.choices.some((choice) => choice.value === modeId) === true;
      if (!known) return { kind: "unknown_mode", modes: this.agentConfigState.modes };
      return this.recordDeferredConfig({
        modes:
          this.agentConfigState.modes === null
            ? null
            : { ...this.agentConfigState.modes, current: modeId },
        options: this.agentConfigState.options.map((candidate) =>
          candidate.category === "mode" ? { ...candidate, value: modeId } : candidate,
        ),
      });
    }
    if (this.terminal || this.stopRequested) return { kind: "terminal", status: this.status };
    if (!session) return { kind: "not_ready", status: this.status };

    // claude fills in modes and kimi publishes only the option, so either one is enough.
    const option = this.agentConfigState.options.find((candidate) => candidate.category === "mode");
    const known =
      this.agentConfigState.modes?.available.some((mode) => mode.id === modeId) === true ||
      option?.choices.some((choice) => choice.value === modeId) === true;
    if (!known) return { kind: "unknown_mode", modes: this.agentConfigState.modes };

    // Not applied here: updateConfig notifies before it returns.
    await session.setMode(modeId);
    return { kind: "ok", config: this.snapshot().agentConfig };
  }

  private onStartFailed(launch: Promise<Session>, error: unknown): void {
    // Ignore a launch a retry superseded: armForStart already cleared exitRecord, so writing one would end the new life.
    if (this.startPromise !== launch) return;
    if (this.exitRecord) return;
    this.exitRecord = {
      reason: this.startAbandoned ? "start_timeout" : "start_failed",
      detail: clip(describeError(error), MAX_EXIT_DETAIL_CHARS),
      at: Date.now(),
      agentHandle: null,
      agentConfirmedDead: true,
    };
    // Not logged on a quiet resume, so boot-pass failures do not fill transcripts with churn.
    if (!this.quietResume) {
      this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    }
    this.touchSafe();
  }

  private onAgentGone(session: Session): void {
    // A late notice from a previous agent must not stop the resumed one.
    if (this.session !== session) return;
    // Our own teardown closes the connection; that is not agent_exited.
    if (this.stopRequested || this.terminal) return;
    void this.stop("agent_exited").catch(() => {});
  }

  stop(reason: ExitReason = "stopped"): Promise<void> {
    // A person's stop or a sign-out relabels a parked session (RELABELS_PARKED); otherwise the settled memo would make Stop a no-op.
    if (RELABELS_PARKED.includes(reason) && this.exitRecord?.reason === "parked") {
      // Mark the intent too, so a wake paused in doResume sees stopRequested and does not run the aborted turn.
      this.stopRequested = true;
      this.stopping ??= Promise.resolve();
      // The relabel overwrites parked; remembered for returnToParked.
      if (reason === "agent_signed_out") this.parkedAtSignOut = true;
      this.exitRecord = { ...this.exitRecord, reason, at: Date.now() };
      this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
      this.touchSafe();
      return Promise.resolve();
    }
    if (this.stopping) return this.stopping;
    // Set before the first await so status and the permission guards see it at once.
    this.stopRequested = true;
    this.stopping = this.doStop(reason);
    return this.stopping;
  }

  /** Puts a session that was only parked when signed out back to parked instead of resuming it; returns whether it acted. */
  returnToParked(): boolean {
    if (!this.parkedAtSignOut) return false;
    this.parkedAtSignOut = false;
    if (this.exitRecord === null || this.exitRecord.reason !== "agent_signed_out") return false;
    this.exitRecord = { ...this.exitRecord, reason: "parked", at: Date.now() };
    this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    this.touchSafe();
    return true;
  }

  private async doStop(reason: ExitReason): Promise<void> {
    this.touchSafe();

    // A start in flight owns a subprocess not yet handed over; wait so it gets disposed.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Already recorded by onStartFailed.
      }
    }

    // Before dispose, not after: a permission parked here keeps the turn alive,
    // which burns the whole cancel grace and pushes teardown onto the kill path.
    this.sweepPending("session_stopped");

    // A dropped queue must say so: each message is already a prompt event with no turn after it (Q2.218).
    // Not for the daemon's own stops, which bring the agent and the queue back.
    const comingBack =
      reason === "daemon_shutdown" || reason === "daemon_restarted" || reason === "config_changed";
    if (!comingBack) this.dropQueuedUndelivered();

    // The controls go with the agent, unannounced: the terminal status below is the event.
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    // Kept for every stop a prompt revives, so a tap is recorded and applied at resume.
    if (!revivableByPrompt(reason, this.agentSessionId)) {
      this.agentConfigState = { modes: null, options: [] };
    }

    // Back to null, meaning unknown; zero would read as room left.
    this.unsubscribeUsage?.();
    this.unsubscribeUsage = null;
    this.contextUsageState = null;

    // Background tasks die with the process and no resume replays them (Q7.113); say so, except for parked, which shows nothing (Q2.224).
    this.unsubscribeBackgroundTasks?.();
    this.unsubscribeBackgroundTasks = null;
    const abandoned = this.backgroundTasksState.filter(
      (task) => !isTerminalAsyncTaskState(task.state),
    ).length;
    if (abandoned > 0 && reason !== "parked") {
      this.safeAppend({ type: "error", message: stoppedWithBackgroundWork(abandoned), data: null });
    }
    // Kept for every stop that keeps the conversation, with what was running marked stopped: its agent is gone (Q2.234).
    this.earlierTasks = revivableByPrompt(reason, this.agentSessionId)
      ? outlivingAgent(this.backgroundTasksState, Date.now())
      : [];
    this.backgroundTasksState = this.earlierTasks;
    this.reportsBackgroundTasksState = false;

    // Whatever the agent was doing goes with the process.
    this.unsubscribeUnprompted?.();
    this.unsubscribeUnprompted = null;
    this.unpromptedSinceState = null;

    // Bumped, never reset: the revision is a change marker clients compare.
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = null;
    // Kept for a revivable stop like the controls: withdrawing it changes the composer and reveals parking (Q2.224).
    if (!revivableByPrompt(reason, this.agentSessionId)) {
      // sameCommands rather than a length test: an empty list can carry a non-zero dropped.
      const withdrawn: AgentCommands = { commands: [], dropped: 0 };
      if (!sameCommands(this.agentCommandsState, withdrawn)) {
        this.agentCommandsState = withdrawn;
        this.commandsRevisionValue += 1;
      }
    }

    const session = this.session;
    const handle = session?.handle ?? null;
    let confirmedDead = true;
    let detail: string | null = null;

    if (session) {
      try {
        await session.dispose();
      } catch (error) {
        detail = describeError(error);
      }
      // Anything but dead gets killed: an agent we could not probe must not be recorded as dead.
      if (handle !== null && (await this.runtime.alive(handle)) !== "dead") {
        await this.runtime.kill(handle, "SIGKILL");
        await delay(KILL_CONFIRM_MS);
        confirmedDead = (await this.runtime.alive(handle)) === "dead";
      }
    }

    // First writer wins, and the caller's reason is kept even when the kill was unconfirmed.
    this.exitRecord ??= {
      reason,
      detail,
      at: Date.now(),
      agentHandle: handle,
      agentConfirmedDead: confirmedDead,
    };
    this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    this.touchSafe();
  }

  /** The exit is set before the event, so status already reads interrupted to any listener. */
  markInterrupted(agentConfirmedDead: boolean, detail: string | null): void {
    if (this.exitRecord) return;
    this.exitRecord = {
      reason: "daemon_restarted",
      detail,
      at: Date.now(),
      agentHandle: this.restoredAgentHandle,
      agentConfirmedDead,
    };
    this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    this.touchSafe();
  }

  /** Synchronous: answers the 202 with turn and seq; attachment bytes are read later in pump. */
  prompt(text: string, attachments: readonly UploadRow[] = []): PromptResult {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    // A clear or restart is replacing the ACP session id, so refuse; a turn in flight gets its own answer.
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };
    if (this.turn !== null) return { kind: "turn_in_flight", status: this.status };

    const turn = this.armTurn();
    const seq = this.recordPrompt(session, text, attachments);
    this.runTurn(session, text, attachments, turn);
    return { kind: "accepted", turn, seq };
  }

  /** Steers into the running turn or queues; logged once, as a prompt event, when accepted (Q2.218). */
  async sendMidTurn(text: string, attachments: readonly UploadRow[] = []): Promise<MidTurnResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };

    // The turn ended after the route's first try; the ordinary path re-guards everything.
    const turn = this.turn;
    if (turn === null) return this.asMidTurn(this.prompt(text, attachments));

    // Counts sends still in flight too, or concurrent sends overshoot before any push. See MAX_QUEUED_PROMPTS.
    if (this.queuedPrompts.length + this.midTurnAccepted >= MAX_QUEUED_PROMPTS) {
      return { kind: "queue_full", limit: MAX_QUEUED_PROMPTS };
    }

    this.midTurnAccepted += 1;
    // Taken before the first await: the queue is ordered by acceptance. See QueuedEntry.order.
    const order = ++this.acceptOrder;
    try {
      const seq = this.recordPrompt(session, text, attachments);

      let promptRequired = false;
      // No steer once a cancel is pending: that turn is being torn down and nothing would answer; the queue survives a cancel.
      if (session.supportsSteering && this.cancelRequestedAt === null) {
        const extra = await this.attachmentBlocks(session, attachments);
        // Re-checked: a cancel may land during the attachment read.
        if (this.cancelRequestedAt === null) {
          const outcome = await session.steer(text, extra);
          if (outcome === "injected") {
            this.touchSafe();
            // The captured turn: pump may have nulled this.turn during the awaits.
            return { kind: "steered", turn, seq };
          }
          if (outcome === "started_new_turn") {
            // Delivered, but in a turn we do not own and will never see end; warn, never resend.
            this.warn?.(`${this.id}: a steered message started a turn this daemon cannot see end`);
            this.touchSafe();
            return { kind: "steered", turn, seq };
          }
          // prompt_required and unsupported fall through; prompt_required is handled after the re-check.
          promptRequired = outcome === "prompt_required";
        }
      }

      // Re-checked after the awaits: a stopped session must not answer queued, and says the message was not delivered (Q2.218).
      if (this.terminal || this.stopRequested) {
        this.safeAppend({ type: "error", message: stoppedBeforeDelivery(1), data: null });
        return { kind: "terminal", status: this.status, exit: this.exitRecord };
      }

      // After the re-check: a clear or restart during the steer sends this to the queue, which it drains. Re-reads this.session, which a restart may replace.
      if (promptRequired && this.turn === null && !this.clearing && !this.restarting) {
        const live = this.session;
        if (live !== null) {
          const started = this.armTurn();
          this.runTurn(live, text, attachments, started);
          return { kind: "accepted", turn: started, seq };
        }
      }

      // Unreachable while every push holds a reservation; guards a future path that skips one, loudly since the prompt is already logged.
      if (this.queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
        this.safeAppend({
          type: "error",
          message: "too many messages were already waiting, so this one was not queued",
          data: null,
        });
        return { kind: "queue_full", limit: MAX_QUEUED_PROMPTS };
      }

      this.queueSeq += 1;
      const entry: QueuedEntry = {
        id: `q_${this.queueSeq}`,
        seq,
        at: Date.now(),
        text,
        attachments,
        order,
      };
      // Inserted by acceptance order, never seq (0 for a failed append), so the agent sees messages in log order.
      const ahead = this.queuedPrompts.findIndex((queued) => queued.order > order);
      const position = ahead === -1 ? this.queuedPrompts.length : ahead;
      this.queuedPrompts.splice(position, 0, entry);
      this.touchSafe();
      // The turn may have ended during the steer, leaving nothing else to drain this entry.
      this.deliverQueued();
      return { kind: "queued", id: entry.id, seq, position };
    } finally {
      // Released only here, so a throwing steer cannot hold a slot for good.
      this.midTurnAccepted -= 1;
    }
  }

  /** turn_in_flight becomes busy: the only caller has just seen no turn. */
  private asMidTurn(result: PromptResult): MidTurnResult {
    return result.kind === "turn_in_flight" ? { kind: "busy", status: result.status } : result;
  }

  /** Synchronous, so the turn guard holds before any await. */
  private armTurn(): number {
    this.turnCounter += 1;
    const turn = this.turnCounter;
    this.turn = turn;
    this.turnStartedAt = Date.now();
    // A cancel of unprompted work that has not ended yet would otherwise end this turn in pump before it is sent.
    this.cancelRequestedAt = null;
    // A new message re-arms one agent replacement; see onAgentUnusable.
    this.authRestartArmed = true;
    return turn;
  }

  /** Called once, on acceptance; delivery never appends a second prompt event. */
  private recordPrompt(session: Session, text: string, attachments: readonly UploadRow[]): number {
    // Only the first prompt names the session, from its text; a manual rename keeps the field non-null.
    if (this.titleValue === null) this.titleValue = deriveSessionTitle(text);

    // Same inputs blocksFor uses, so the logged inlined flag matches what the agent gets.
    const caps = { image: session.acceptsImages };
    const refs =
      attachments.length === 0
        ? null
        : attachments.map((row) => ({
            uploadId: row.uploadId,
            name: row.name,
            mime: row.mime,
            bytes: row.bytes,
            inlined: inlinesImage(row.mime, row.bytes, caps),
          }));

    const seq = this.safeAppend({ type: "prompt", text, attachments: refs })?.seq ?? 0;

    // Marked even if the append failed; a queued message spends at accept so the 24-hour sweep cannot collect its files.
    if (attachments.length > 0) {
      this.uploads?.markConsumed(
        this.id,
        attachments.map((row) => row.uploadId),
      );
    }
    return seq;
  }

  /** The only read of attachment bytes, shared by pump and sendMidTurn so both decide image support as recordPrompt logged it. */
  private async attachmentBlocks(
    session: Session,
    attachments: readonly UploadRow[],
  ): Promise<acp.ContentBlock[]> {
    if (attachments.length === 0 || !this.uploads) return [];
    return await this.uploads.blocksFor(attachments, { image: session.acceptsImages });
  }

  /** Hand the turn to the agent. The half of a send that is the same either way. */
  private runTurn(
    session: Session,
    text: string,
    attachments: readonly UploadRow[],
    turn: number,
  ): void {
    void this.pump(session, text, attachments, turn).catch(() => {
      // pump() already recorded whatever went wrong.
    });
    this.touchSafe();
  }

  /** One error for all dropped messages: each is already a prompt event with no turn end (Q2.218). */
  private dropQueuedUndelivered(): void {
    const dropped = this.queuedPrompts.length;
    if (dropped === 0) return;
    this.queuedPrompts = [];
    this.safeAppend({ type: "error", message: stoppedBeforeDelivery(dropped), data: null });
  }

  /** Called last in pump's finally; clearContext and restartAgent call it again on their way out. */
  private deliverQueued(): void {
    if (this.queuedPrompts.length === 0) return;
    if (this.terminal || this.stopRequested) return;
    if (this.clearing || this.restarting) return;
    if (this.turn !== null) return;
    const session = this.session;
    if (!session) return;

    const entry = this.queuedPrompts.shift();
    if (entry === undefined) return;
    const turn = this.armTurn();
    // No recordPrompt: logged, and its uploads spent, at acceptance.
    this.runTurn(session, entry.text, entry.attachments, turn);
  }

  /** Cancels the turn but keeps the agent; sends, then sweeps pending permissions, which ACP requires be answered cancelled. */
  async cancelTurn(): Promise<CancelResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    // Before the turn test: a clear holds no turn and must answer busy, not no_turn.
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };
    const turn = this.turn;
    if (turn === null) return await this.cancelWithoutTurn(session);

    // Recorded before the await so a snapshot already shows the cancel.
    this.cancelRequestedAt = Date.now();
    this.touchSafe();

    try {
      await session.cancelTurn();
    } catch {
      // Unreachable agent: pump's error path ends the turn, and the sweep below still runs.
    } finally {
      // Fenced on this turn: a new turn started meanwhile keeps its permissions.
      if (this.turn === turn) this.sweepPending("turn_cancelled");
      this.touchSafe();
    }

    // After the sweep: an agent blocked on a permission cannot end its turn until answered.
    const settled = await session.awaitTurnEnd();
    return { kind: "cancelled", turn, settled };
  }

  /** The same send, sweep, watch, for an agent working unprompted or waiting on a request no turn holds (Q2.232, Q2.233). */
  private async cancelWithoutTurn(session: Session): Promise<CancelResult> {
    const working = this.unpromptedSinceState !== null;
    if (!working && this.awaitingCount === 0) return { kind: "no_turn", status: this.status };

    if (working) this.cancelRequestedAt = Date.now();
    this.touchSafe();

    try {
      await session.cancelTurn();
    } catch {
      // Unreachable agent: the sweep below still answers what it parked.
    } finally {
      // Fenced like the turn's: a turn that began during the send keeps what it parks.
      if (this.turn === null) this.sweepPending("turn_cancelled");
      this.touchSafe();
    }

    const settled = working ? await session.awaitUnpromptedEnd() : true;
    return { kind: "cancelled", turn: null, settled };
  }

  /** Checks the id against announced tasks before it reaches the agent; not gated on the turn, since tasks outlive prompts. */
  async stopBackgroundTask(asyncTaskId: string): Promise<StopTaskResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    const session = this.session;
    if (session === null || this.stopRequested) return { kind: "not_ready", status: this.status };
    if (!this.backgroundTasksState.some((task) => task.id === asyncTaskId)) {
      return { kind: "no_task" };
    }
    try {
      return { kind: "answered", stopped: await session.stopAsyncTask(asyncTaskId) };
    } catch (error) {
      // failed, never stopped false, which would mean the work had already ended.
      return { kind: "failed", detail: describeError(error) };
    }
  }

  private async pump(
    session: Session,
    text: string,
    attachments: readonly UploadRow[],
    turn: number,
  ): Promise<void> {
    let failed = false;
    try {
      const extra = await this.attachmentBlocks(session, attachments);
      // A cancel can land during the attachment read, before the agent holds a prompt; end the turn here instead.
      if (this.turn === turn && this.cancelRequestedAt !== null) {
        this.record({ type: "turn_end", stopReason: "cancelled", usage: null });
        return;
      }
      let errored = false;
      for await (const event of session.prompt(text, extra)) {
        // A CLOSED error is our own teardown, not an agent failure.
        errored = event.type === "error" && !isSessionClosed(event);
        // A recording fault must not unwind this loop: that aborts the turn and cancels pending permissions.
        try {
          this.record(event);
        } catch {
          // Already degraded inside the store; nothing useful to do here.
        }
      }
      // An errored turn still ended: write the turn_end the agent never sends (Q2.103).
      if (errored && !this.stopRequested) {
        this.record({ type: "turn_end", stopReason: "agent_error", usage: null });
      }
    } catch (error) {
      failed = true;
      try {
        this.record({
          type: "error",
          message: describeError(error),
          data: null,
        });
      } catch {
        // Nothing left to report with.
      }
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.turnStartedAt = null;
        // Inside the identity test: a late pump must not erase a cancel on the current turn.
        this.cancelRequestedAt = null;
        // Restart the idle drain on this.session, so a replaced agent's pump does not attach to the old one.
        const live = this.session;
        // Not when queued: deliverQueued below claims the queue for a turn.
        if (live !== null && this.queuedPrompts.length === 0) this.startIdleDrain(live);
      }
      // No sweep: a request is settled by an answer, a cancel, its withdrawal or the agent going, never by a turn ending (Q2.232).
      // A rejected prompt means the agent process is finished: replace it.
      if (failed) this.onAgentUnusable();
      this.touchSafe();
      // Last: a restart armed above drains the queue when it finishes.
      this.deliverQueued();
    }
  }

  private record(event: SessionEvent): void {
    this.lastEventAt = this.lastAgentEventAt = Date.now();
    // While stopping, the generator's synthetic closed error is not a failure.
    if (this.stopRequested && event.type === "error") return;
    this.log.append(event);
    // Never record a start refusal here: a stale session's auth failure is not about the credential (Q7.99).
    if (isAuthFailure(event)) this.onAgentUnusable();
  }

  /** Replaces the agent process, keeping the conversation, after an auth failure or a rejected prompt; armed once per prompt (Q7.99). */
  private onAgentUnusable(): void {
    if (this.terminal || this.stopRequested) return;
    // A restart in flight is left alone: a second would overwrite this.restart and strand its waiters.
    if (this.restarting) return;
    if (!this.authRestartArmed) return;
    this.authRestartArmed = false;
    void this.restartAgent().catch(() => undefined);
  }

  /** The returned promise holds the agent's turn open, independent of any connection. */
  private readonly resolvePermission = (
    request: PendingPermission,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> => {
    // Refuse to park only what nobody could answer, a dead session: an agent working between turns is answerable (Q2.232).
    const refusal = this.refusalReason();
    if (refusal) return Promise.resolve(this.recordRefusal(request, refusal));

    const permissionId = this.mintPermissionId();
    const info: PendingPermissionSnapshot = {
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      raisedAt: Date.now(),
      rawInput: clampBlob(request.rawInput, MAX_PERMISSION_BLOB_BYTES),
      content: clampBlob(request.content, MAX_PERMISSION_BLOB_BYTES),
      outOfTurn: this.turn === null,
    };

    // One statement in the executor: a throw there would reject while leaving the entry pending.
    let resolve!: (response: acp.RequestPermissionResponse) => void;
    const parked = new Promise<acp.RequestPermissionResponse>((capture) => {
      resolve = capture;
    });

    this.pending.set(permissionId, { info, resolve });
    this.safeAppend({
      type: "permission_request",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      decision: null,
    });

    if (signal.aborted) {
      this.settle(permissionId, CANCELLED, "agent_withdrew");
    } else {
      signal.addEventListener(
        "abort",
        () => this.settle(permissionId, CANCELLED, "agent_withdrew"),
        { once: true },
      );
    }

    this.touchSafe();
    return parked;
  };

  private refusalReason(): AnswerResolvedBy | null {
    if (this.terminal || this.stopRequested) return "session_stopped";
    return null;
  }

  private recordRefusal(
    request: PendingPermission,
    by: AnswerResolvedBy,
  ): acp.RequestPermissionResponse {
    // Recorded, so a refused request is not mistaken for one never raised.
    const permissionId = this.mintPermissionId();
    this.safeAppend({
      type: "permission_request",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      decision: null,
    });
    this.resolved.set(permissionId, { outcome: "cancelled", optionId: null, at: Date.now(), by });
    this.safeAppend({
      type: "permission_resolved",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      outcome: "cancelled",
      optionId: null,
      by,
    });
    return CANCELLED;
  }

  answerPermission(permissionId: string, answer: PermissionAnswer): PermissionResult {
    const record = this.pending.get(permissionId);
    if (!record) {
      const prior = this.resolved.get(permissionId);
      if (prior) return { kind: "already_answered", permissionId, ...prior };
      // "Too old to report" must never come back as "never existed".
      return this.looksLikeOurs("perm", permissionId)
        ? { kind: "expired", permissionId }
        : { kind: "not_found" };
    }

    const pick = chooseOption(answer, record.info.options);
    if (pick.kind !== "ok") return { kind: pick.kind, options: [...record.info.options] };

    const settled = this.settle(permissionId, pick.response, "client");
    if (!settled) return { kind: "not_found" };
    return {
      kind: "ok",
      permissionId,
      outcome: settled.outcome,
      optionId: settled.optionId,
      seq: settled.seq,
      // We cannot prove the agent received it — the SDK swallows send failures
      // once its connection is gone. Only a later event in the log proves effect.
      delivered: this.session !== null && !this.terminal ? "sent" : "agent_gone",
    };
  }

  /** The only exit from pending: the delete is the compare-and-swap, and the agent is unblocked before logging. */
  private settle(
    permissionId: string,
    response: acp.RequestPermissionResponse,
    by: AnswerResolvedBy,
  ): { outcome: "selected" | "cancelled"; optionId: string | null; seq: number | null } | null {
    const record = this.pending.get(permissionId);
    if (!record) return null;
    this.pending.delete(permissionId);

    const outcome = response.outcome.outcome === "selected" ? "selected" : "cancelled";
    const optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : null;
    this.resolved.set(permissionId, { outcome, optionId, at: Date.now(), by });

    try {
      record.resolve(response);
    } catch {
      // A promise only settles once; a duplicate is not an error worth surfacing.
    }

    let seq: number | null = null;
    try {
      seq = this.log.append({
        type: "permission_resolved",
        permissionId,
        toolCallId: record.info.toolCallId,
        title: record.info.title,
        outcome,
        optionId,
        by,
      }).seq;
    } catch {
      // The decision already reached the agent; losing the record is survivable.
    }
    this.touchSafe();
    return { outcome, optionId, seq };
  }

  /** Both maps. Only a stop and a cancel sweep: a turn ending is not an answer (Q2.232). */
  private sweepPending(by: AnswerResolvedBy): void {
    for (const permissionId of [...this.pending.keys()]) {
      this.settle(permissionId, CANCELLED, by);
    }
    for (const elicitationId of [...this.pendingElicitations.keys()]) {
      this.settleElicitation(elicitationId, ELICITATION_CANCELLED, by);
    }
  }

  /** Twin of resolvePermission, kept separate so a permission answer can never reach a question. */
  private readonly resolveElicitation = (
    request: PendingElicitation,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> => {
    const refusal = this.refusalReason();
    if (refusal) return Promise.resolve(this.recordElicitationRefusal(request, refusal));

    const elicitationId = this.mintElicitationId();
    const info: PendingElicitationSnapshot = {
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
      // The form is left out: snapshots are listed often, and the elicitation route serves it.
      fieldCount: request.form.fields.length,
      raisedAt: Date.now(),
    };

    // One statement in the executor, as in resolvePermission.
    let resolve!: (response: acp.CreateElicitationResponse) => void;
    const parked = new Promise<acp.CreateElicitationResponse>((capture) => {
      resolve = capture;
    });

    this.pendingElicitations.set(elicitationId, { info, form: request.form, resolve });
    this.safeAppend({
      type: "elicitation_request",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
    });

    if (signal.aborted) {
      this.settleElicitation(elicitationId, ELICITATION_CANCELLED, "agent_withdrew");
    } else {
      signal.addEventListener(
        "abort",
        () => this.settleElicitation(elicitationId, ELICITATION_CANCELLED, "agent_withdrew"),
        { once: true },
      );
    }

    this.touchSafe();
    return parked;
  };

  private recordElicitationRefusal(
    request: PendingElicitation,
    by: AnswerResolvedBy,
  ): acp.CreateElicitationResponse {
    const elicitationId = this.mintElicitationId();
    this.safeAppend({
      type: "elicitation_request",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
    });
    this.resolvedElicitations.set(elicitationId, { action: "cancel", at: Date.now(), by });
    this.safeAppend({
      type: "elicitation_resolved",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
      action: "cancel",
      answers: null,
      by,
    });
    return ELICITATION_CANCELLED;
  }

  /** The form a client is being asked to fill in, or `null` once it is settled. */
  elicitationForm(elicitationId: string): ElicitationForm | null {
    return this.pendingElicitations.get(elicitationId)?.form ?? null;
  }

  answerElicitation(elicitationId: string, answer: ElicitationAnswerBody): ElicitationResult {
    const record = this.pendingElicitations.get(elicitationId);
    if (!record) {
      const prior = this.resolvedElicitations.get(elicitationId);
      if (prior) return { kind: "already_answered", elicitationId, ...prior };
      // Too old to report must never come back as never existed.
      return this.looksLikeOurs("elic", elicitationId)
        ? { kind: "expired", elicitationId }
        : { kind: "not_found" };
    }

    let response: acp.CreateElicitationResponse;
    let answers: ElicitationAnswer[] | null = null;
    if ("content" in answer) {
      const problems = validateElicitationContent(record.form, answer.content);
      if (problems.length > 0) {
        return { kind: "invalid_content", problems, fields: [...record.form.fields] };
      }
      response = { action: "accept", content: answer.content };
      answers = renderAnswers(record.form, answer.content);
    } else if ("decline" in answer) {
      response = { action: "decline" };
    } else {
      response = ELICITATION_CANCELLED;
    }

    const settled = this.settleElicitation(elicitationId, response, "client", answers);
    if (!settled) return { kind: "not_found" };
    return {
      kind: "ok",
      elicitationId,
      action: settled.action,
      seq: settled.seq,
      delivered: this.session !== null && !this.terminal ? "sent" : "agent_gone",
    };
  }

  /** The only exit from pendingElicitations; same ordering as settle. */
  private settleElicitation(
    elicitationId: string,
    response: acp.CreateElicitationResponse,
    by: AnswerResolvedBy,
    answers: ElicitationAnswer[] | null = null,
  ): { action: "accept" | "decline" | "cancel"; seq: number | null } | null {
    const record = this.pendingElicitations.get(elicitationId);
    if (!record) return null;
    this.pendingElicitations.delete(elicitationId);

    const action =
      response.action === "accept" ? "accept" : response.action === "decline" ? "decline" : "cancel";
    this.resolvedElicitations.set(elicitationId, { action, at: Date.now(), by });

    try {
      record.resolve(response);
    } catch {
      // A promise only settles once; a duplicate is not an error worth surfacing.
    }

    let seq: number | null = null;
    try {
      seq = this.log.append({
        type: "elicitation_resolved",
        elicitationId,
        toolCallId: record.info.toolCallId,
        message: record.info.message,
        action,
        // Clipped for the log only; the agent got the answer verbatim.
        answers:
          action === "accept" && answers !== null
            ? answers.map((entry) => ({
                ...entry,
                value: clip(entry.value, MAX_ELICITATION_ANSWER_CHARS),
              }))
            : null,
        by,
      }).seq;
    } catch {
      // The answer already reached the agent; losing the record is survivable.
    }
    this.touchSafe();
    return { action, seq };
  }

  private mintPermissionId(): string {
    this.askSeq += 1;
    return `perm-${this.askSeq}-${this.askSalt}`;
  }

  private mintElicitationId(): string {
    this.askSeq += 1;
    return `elic-${this.askSeq}-${this.askSalt}`;
  }

  /** One check for both id kinds, so an expired id never reads as one that never existed. */
  private looksLikeOurs(prefix: "perm" | "elic", id: string): boolean {
    const match = new RegExp(`^${prefix}-(\\d+)-([0-9a-f]{3})$`).exec(id);
    if (!match) return false;
    return match[2] === this.askSalt && Number(match[1]) <= this.askSeq;
  }

  // Nothing below may throw into a caller.

  private safeAppend(event: SessionEvent): StoredEvent | null {
    try {
      this.lastEventAt = Date.now();
      return this.log.append(event);
    } catch {
      return null;
    }
  }

  private touchSafe(): void {
    let snapshot: SessionSnapshot;
    try {
      snapshot = this.snapshot();
    } catch {
      return;
    }

    // Persisted before the fan-out, in its own guard; a hook, not a watcher, since a throwing watcher is evicted.
    try {
      this.sessionStore?.put(this.persistedRow(snapshot));
    } catch {
      // The store already swallowed it; this is the second belt.
    }

    for (const watcher of [...this.watchers]) {
      try {
        watcher(snapshot);
      } catch {
        this.watchers.delete(watcher);
      }
    }
  }

  private persistedRow(snapshot: SessionSnapshot): PersistedSession {
    return {
      id: this.id,
      agent: this.agent,
      customAgent: this.customAgent,
      createdAt: this.createdAt,
      workspace: this.workspace,
      agentSessionId: snapshot.agentSessionId,
      agentHandle: snapshot.agentHandle,
      status: snapshot.status,
      exit: snapshot.exit,
      turnCounter: this.turnCounter,
      lastEventAt: this.lastEventAt,
      askSeq: this.askSeq,
      askSalt: this.askSalt,
      // Only a give-up that persists; attempts_exhausted must stay transient.
      resumeGaveUp:
        this.resumeGivenUp !== null && resumeGiveUpPersists(this.resumeGivenUp)
          ? this.resumeGivenUp
          : null,
      lastSeq: snapshot.lastSeq,
      dropped: snapshot.dropped,
      title: snapshot.title,
      pinned: snapshot.pinned,
      rank: snapshot.rank,
      // The choice, never ultracodeWanted, or the machine default would be pinned into the row.
      ultracode: this.ultracodeChoice,
      // Only for a session a prompt would revive, the gate doStop clears on; null while live.
      agentState:
        snapshot.exit !== null &&
        revivableByPrompt(snapshot.exit.reason, snapshot.agentSessionId)
          ? reduceAgentState(this.agentConfigState, this.agentCommandsState, this.backgroundTasksState)
          : null,
    };
  }
}

export interface CreateSessionOptions {
  agent: AgentId;
  /** The assembled agent's id; agent is still the harness, and ManagedSession.assembled handles the two diverging. */
  customAgent?: string | null;
  cwd: string;
  /** Omitted, the daemon-wide default applies. */
  worktree?: WorktreePolicy;
  /** Client-supplied branch name. Validated by git before use. */
  branch?: string | null;
  /** Who asked, when not a person: passed to observers, never stored, and never read from a request body. */
  origin?: string | null;
  /** Overrides the daemon-wide worktree root; the offline drivers use it. */
  worktreeRoot?: string;
}

export type WorktreePolicy = "auto" | "require" | "never";

export interface WorkspacePolicy {
  worktreeRoot: string;
  branchPrefix: string;
  defaultMode: WorktreePolicy;
}

const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  worktreeRoot: resolveWorktreeRoot(undefined),
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  defaultMode: "auto",
};

export interface RestoreOptions {
  /** SIGKILL agent process groups the previous daemon left behind. */
  reapOrphans?: boolean;
}

export interface RestoreReport {
  restored: number;
  interrupted: number;
  reaped: number;
}

export interface AutoResumeOptions {
  /** Off turns the whole thing into a no-op, both here and on the prompt path. */
  enabled?: boolean;
  concurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Seams, so a driver can run the retry logic without waiting out a backoff. */
  random?: () => number;
  delay?: (ms: number) => Promise<void>;
  /** Where `src/` reports instead of printing. `scripts/` does the printing. */
  onOutcome?: (outcome: AutoResumeOutcome) => void;
}

export type AutoResumeResult =
  | "resumed"
  | "skipped"
  | "workspace_missing"
  | "workspace_unresponsive"
  | "unsupported"
  | "forgotten"
  | "failed"
  | "attempts_exhausted"
  /** No CLI for the harness here: not an attempt, and the daemon runs the installer on it. */
  | "agent_missing";

export interface AutoResumeOutcome {
  sessionId: string;
  result: AutoResumeResult;
  attempt: number;
  detail: string | null;
}

export interface AutoResumeReport {
  considered: number;
  resumed: number;
  skipped: number;
  failed: number;
  /** Left waiting for a CLI the machine does not have yet — see `agent_missing`. */
  deferred: number;
}

/** restored means the daemon already had it; a session ending is an event in its own log. */
export type SessionObserver = (
  managed: ManagedSession,
  arrival: "created" | "restored",
  /** CreateSessionOptions.origin verbatim; null for restored and client-created sessions. */
  origin: string | null,
) => void;

export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly observers = new Set<SessionObserver>();
  private shuttingDown = false;
  /** One switch for the boot pass and the prompt-path resume; injected because this file reads no env. */
  private autoResumeAllowed = true;
  /** Off withdraws the agent's question tool, not only the UI. */
  private elicitationAllowed = true;

  /** A setter because restore runs before the store opens; the default means a bare harness. */
  private resolveCustomAgentBy: (
    id: string,
  ) => { harness: AgentId; system: SystemId; model: string } | null = () => null;

  /** Ultracode for sessions that have not chosen; off unless the machine opts in. */
  private ultracodeByDefault = false;

  /** Must be set before restore, or sessions on a plugin harness come back demoted to their bare harness. */
  private machine: MachineCatalogue = BUILTIN_CATALOGUE;

  /** See {@link machine}. Called by `daemon.ts` before `restore()`. */
  setMachineCatalogue(machine: MachineCatalogue): void {
    this.machine = machine;
  }

  /** What this machine offers, for the routes that list and refuse. */
  get machineCatalogue(): MachineCatalogue {
    return this.machine;
  }

  private maxLiveSessions = MAX_LIVE_SESSIONS;
  /** The configured value; storedIdleParkMs overrides it, and clearing that setting returns to this. */
  private idleParkMs = IDLE_PARK_MS;
  /** Env only, with no stored override: a backstop for an adapter that stopped answering. See TURN_SILENCE_MS. */
  private turnSilenceMs = TURN_SILENCE_MS;
  /** See CEILING_PARK_FLOOR_MS; injectable so drivers can fake it. */
  private ceilingParkFloorMs = CEILING_PARK_FLOOR_MS;
  /** What somebody set on the settings screen, or `null` if nobody has. */
  private storedIdleParkMs: number | null = null;
  private settingsStore: MachineSettingsPort | null = null;
  private createBurst = SESSION_CREATE_BURST;
  private createRefillMs = SESSION_CREATE_REFILL_MS;
  private createTokens = SESSION_CREATE_BURST;
  private createTokensAt = Date.now();

  constructor(
    private readonly store: EventStore = new MemoryEventStore(),
    private readonly sessionStore: SessionStore | null = null,
    private readonly policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY,
    private readonly runtime: SessionRuntime = new LocalRuntime(),
    private readonly uploads: UploadsPort | null = null,
    /** Where sessions report degradations; silent by default. */
    private readonly onWarning: ((detail: string) => void) | undefined = undefined,
  ) {}

  /** The harness rides along so ManagedSession.assembled can detect a preset re-pointed at another harness. */
  setCustomAgents(
    resolve: (id: string) => { harness: AgentId; system: SystemId; model: string } | null,
  ): void {
    this.resolveCustomAgentBy = resolve;
  }

  /** A throwing observer is reported through onWarning and kept, never evicted. */
  watchSessions(observer: SessionObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private announce(managed: ManagedSession, arrival: "created" | "restored", origin: string | null): void {
    for (const observer of this.observers) {
      try {
        observer(managed, arrival, origin);
      } catch (error) {
        this.onWarning?.(`session observer threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  get workspacePolicy(): WorkspacePolicy {
    return this.policy;
  }

  get sessionRuntime(): SessionRuntime {
    return this.runtime;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get autoResumeEnabled(): boolean {
    return this.autoResumeAllowed;
  }

  setAutoResume(enabled: boolean): void {
    this.autoResumeAllowed = enabled;
  }

  get elicitationEnabled(): boolean {
    return this.elicitationAllowed;
  }

  setElicitation(enabled: boolean): void {
    this.elicitationAllowed = enabled;
  }

  get ultracodeDefault(): boolean {
    return this.ultracodeByDefault;
  }

  /** Read through a thunk at every launch, because restore runs before this is set. */
  setUltracode(enabled: boolean): void {
    this.ultracodeByDefault = enabled;
  }

  /** The creation and parking bounds from the environment. */
  setSessionLimits(limits: {
    live?: number;
    burst?: number;
    refillMs?: number;
    idleParkMs?: number;
    ceilingFloorMs?: number;
    turnSilenceMs?: number;
  }): void {
    if (limits.live !== undefined) this.maxLiveSessions = Math.max(1, limits.live);
    // 0 switches parking off, so clamp at zero, not one.
    if (limits.idleParkMs !== undefined) this.idleParkMs = Math.max(0, limits.idleParkMs);
    // 0 is meaningful: drivers use it to disable the floor.
    if (limits.ceilingFloorMs !== undefined) this.ceilingParkFloorMs = Math.max(0, limits.ceilingFloorMs);
    // 0 switches it off; a floor would turn a typo into ending every turn at once.
    if (limits.turnSilenceMs !== undefined) this.turnSilenceMs = Math.max(0, limits.turnSilenceMs);
    if (limits.burst !== undefined) {
      const previous = this.createBurst;
      this.createBurst = Math.max(1, limits.burst);
      // A raise adds its headroom at once rather than one refill at a time, and refunds nothing already spent; a lowering clamps.
      this.createTokens = Math.min(this.createTokens + Math.max(0, this.createBurst - previous), this.createBurst);
    }
    if (limits.refillMs !== undefined) this.createRefillMs = Math.max(1, limits.refillMs);
  }

  /** Sessions holding or entitled to an agent, not conversations. */
  get liveSessionCount(): number {
    let live = 0;
    for (const session of this.sessions.values()) if (!session.terminal) live += 1;
    return live;
  }

  /** The sweep and a wake's eviction both read this, so one setting switches both off. */
  get idleParkEnabled(): boolean {
    return this.effectiveIdleParkMs > 0;
  }

  /** Separate from idleParkEnabled: two policies that share a clock. */
  get turnSilenceEnabled(): boolean {
    return this.turnSilenceMs > 0;
  }

  /** Synchronous and unpaced, since it only queues an event; returns ids for the operator line, which names turns only. */
  abandonWedgedTurns(now = Date.now()): string[] {
    if (this.turnSilenceMs <= 0 || this.shuttingDown) return [];
    const abandoned: string[] = [];
    for (const session of this.sessions.values()) {
      // Same clock, same bound: the evidence is the agent saying nothing, turn or not (Q2.233).
      if (session.unpromptedGoneQuiet(now, this.turnSilenceMs)) session.endUnprompted();
      if (!session.wedged(now, this.turnSilenceMs)) continue;
      if (session.abandonTurn()) abandoned.push(session.id);
    }
    return abandoned;
  }

  // The stored setting wins over the env default.
  private get effectiveIdleParkMs(): number {
    return this.storedIdleParkMs ?? this.idleParkMs;
  }

  /** Where this machine's preferences are kept. `daemon.ts` supplies it. */
  setMachineSettingsStore(store: MachineSettingsPort | null): void {
    this.settingsStore = store;
    this.applyMachineSettings();
  }

  /** Called at boot and by PATCH /settings; an unreadable or out-of-range value counts as absent. */
  applyMachineSettings(): void {
    const raw = this.settingsStore?.read("idleReleaseMinutes") ?? null;
    const minutes = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    this.storedIdleParkMs =
      Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_IDLE_RELEASE_MINUTES
        ? minutes * 60_000
        : null;
  }

  machineSettings(): MachineSettingsView {
    return { idleReleaseMinutes: Math.round(this.effectiveIdleParkMs / 60_000) };
  }

  /** Least recently active first; the sweep takes all of them, a wake takes the head. */
  private parkCandidates(now: number, idleMs: number): ManagedSession[] {
    const ready: ManagedSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.parkable(now, idleMs)) ready.push(session);
    }
    return ready.sort(
      (a, b) => (a.lastActivityAt ?? a.createdAt) - (b.lastActivityAt ?? b.createdAt),
    );
  }

  /** Sequential to avoid a park storm under memory pressure; re-checks each session because parking awaits. */
  async parkIdleSessions(now = Date.now()): Promise<string[]> {
    if (this.effectiveIdleParkMs <= 0 || this.shuttingDown) return [];
    const parked: string[] = [];
    for (const session of this.parkCandidates(now, this.effectiveIdleParkMs)) {
      if (this.shuttingDown) break;
      if (!session.parkable(now, this.effectiveIdleParkMs)) continue;
      await session.stop("parked");
      parked.push(session.id);
    }
    return parked;
  }

  /** Parks the oldest idle session past the ceiling floor, not the idle threshold, unless parking is off; frees one slot only. */
  private async releaseOneSlot(): Promise<boolean> {
    // Room first: with parking off, a machine under the ceiling must still create.
    if (this.liveSessionCount < this.maxLiveSessions) return true;
    if (this.effectiveIdleParkMs <= 0) return false;
    const [oldest] = this.parkCandidates(Date.now(), this.ceilingParkFloorMs);
    if (oldest === undefined) return false;
    await oldest.stop("parked");
    return true;
  }

  /** Same tests as releaseOneSlot without evicting, so create checks the rate limit before evicting anyone. */
  private canReleaseOneSlot(): boolean {
    if (this.liveSessionCount < this.maxLiveSessions) return true;
    if (this.effectiveIdleParkMs <= 0) return false;
    return this.parkCandidates(Date.now(), this.ceilingParkFloorMs).length > 0;
  }

  /** Never refuses a wake: going over a soft ceiling beats telling someone their conversation is unavailable. */
  private async makeRoomForWake(): Promise<void> {
    // Eviction spends a creation token so wake loops are rate-bounded; with none the wake proceeds over the ceiling.
    if (this.liveSessionCount < this.maxLiveSessions) return;
    if (this.takeCreateSlot(Date.now()) > 0) return;
    await this.releaseOneSlot();
  }

  /** Token bucket refilled by elapsed time; returns 0, or the seconds to wait. */
  private takeCreateSlot(now: number): number {
    const elapsed = now - this.createTokensAt;
    const gained = Math.floor(elapsed / this.createRefillMs);
    if (gained > 0) {
      this.createTokens = Math.min(this.createBurst, this.createTokens + gained);
      this.createTokensAt += gained * this.createRefillMs;
    }
    if (this.createTokens <= 0) {
      const wait = this.createRefillMs - (now - this.createTokensAt);
      return Math.max(1, Math.ceil(wait / 1000));
    }
    this.createTokens -= 1;
    return 0;
  }

  /** Wakes a terminal session before a prompt, parked ones even with auto-resume off; used by the route and the plugin API. */
  async wakeForPrompt(managed: ManagedSession): Promise<void> {
    if (
      managed.terminal &&
      (this.autoResumeEnabled || managed.exit?.reason === "parked") &&
      // Same gate as the boot pass: an agent that forgot this conversation will say so again.
      !managed.resumeSettled &&
      autoResumable(managed.exit, managed.agentSessionId, "prompt")
    ) {
      try {
        await managed.resume();
      } catch {
        // Swallowed: resume restores the original exit, so the caller reports how the session really ended.
      }
    }
  }

  async create(options: CreateSessionOptions): Promise<ManagedSession> {
    // Capacity is weighed before touching the filesystem, and the ceiling before the rate, so the refusals never mask each other.
    // Make room before refusing: releasing an idle agent is lossless (Q2.223).
    if (!this.canReleaseOneSlot()) {
      throw new SessionLimitError(
        "too_many_sessions",
        0,
        `this machine is limited to ${this.maxLiveSessions} live sessions (REEMOAT_MAX_LIVE_SESSIONS) and every one of them is busy; wait for one to finish, or stop one`,
      );
    }
    const wait = this.takeCreateSlot(Date.now());
    if (wait > 0) {
      throw new SessionLimitError(
        "session_rate_limited",
        wait,
        `too many sessions created recently; try again in ${wait}s`,
      );
    }
    // Evict only after paying for a slot, so the creation rate also bounds evictions; false here is a lost race.
    if (!(await this.releaseOneSlot())) {
      throw new SessionLimitError(
        "too_many_sessions",
        0,
        `this machine is limited to ${this.maxLiveSessions} live sessions (REEMOAT_MAX_LIVE_SESSIONS) and every one of them is busy; wait for one to finish, or stop one`,
      );
    }

    // Both throw before anything is spawned or recorded, so a bad cwd or agent is a clean 4xx.
    const cwd = await resolveCwd(options.cwd);
    this.runtime.describe(options.agent);

    // Checked before the worktree exists: create leaves it behind on failure.
    const availability = await this.runtime.availability();
    const agentState = availability.find((entry) => entry.id === options.agent);
    if (agentState && !agentState.available) {
      throw new AgentUnavailableError(
        agentState.hint ?? `${options.agent} is not available in this runtime`,
      );
    }

    // Fail fast on a recorded auth refusal before creating anything, for bare, native or routed-refused starts; a bare refusal says nothing about a routed start.
    const refusal = agentState?.lastStartRefusal ?? null;
    if (refusal !== null) {
      const preset = options.customAgent == null ? null : this.resolveCustomAgentBy(options.customAgent);
      // An unresolvable preset starts bare, as assembled reads it.
      const nativeHere =
        preset !== null && this.machine.system(preset.system)?.nativeHarness === options.agent;
      if (refusal.routed || options.customAgent == null || nativeHere) {
        throw new Error(refusal.message);
      }
    }

    // Minted before the workspace, because the worktree path and branch name
    // embed it.
    const id = `s_${randomBytes(4).toString("hex")}`;

    // Created before the session is registered, so a WorktreeError is a clean 4xx
    // with nothing on disk and nothing in the map to clean up.
    const { workspace, warnings } = await createWorkspace({
      cwd,
      sessionId: id,
      policy: options.worktree ?? this.policy.defaultMode,
      worktreeRoot: options.worktreeRoot ?? this.policy.worktreeRoot,
      branchPrefix: this.policy.branchPrefix,
      branchHint: options.branch ?? null,
      // Runs the repository's own hooks and filters, as this user.
      runner: this.runtime.git(),
    });

    const managed = new ManagedSession(id, options.agent, workspace, this.store, {
      customAgent: options.customAgent ?? null,
      // Re-read through `this` at every call, never captured — see the field.
      resolveCustomAgent: (id) => this.resolveCustomAgentBy(id),
      machineCatalogue: () => this.machine,
      sessionStore: this.sessionStore,
      makeRoomForWake: () => this.makeRoomForWake(),
      runtime: this.runtime,
      uploads: this.uploads,
      elicitationAllowed: () => this.elicitationAllowed,
      ultracodeDefault: () => this.ultracodeByDefault,
      onWarning: this.onWarning,
    });
    this.sessions.set(id, managed);
    // Before start, so an attach from zero sees the workspace before the agent's output.
    managed.recordWorkspace(warnings);
    // Announced before launch so observers attach before the agent's first event; origin is kept nowhere.
    this.announce(managed, "created", options.origin ?? null);

    // On failure the worktree is deliberately kept; the session stays listed and terminal.
    await managed.start();
    return managed;
  }

  /** Rebuilds persisted sessions without spawning; run after the daemon lock is held and before serving. */
  restore(options: RestoreOptions = {}): RestoreReport {
    if (!this.sessionStore) return { restored: 0, interrupted: 0, reaped: 0 };
    let interrupted = 0;
    let reaped = 0;

    for (const row of this.sessionStore.list()) {
      if (this.sessions.has(row.id)) continue;
      const managed = ManagedSession.restore(row, this.store, {
        sessionStore: this.sessionStore,
        makeRoomForWake: () => this.makeRoomForWake(),
        runtime: this.runtime,
        uploads: this.uploads,
        // Thunks: restore runs before daemon.ts reads the environment.
        elicitationAllowed: () => this.elicitationAllowed,
        ultracodeDefault: () => this.ultracodeByDefault,
        resolveCustomAgent: (id) => this.resolveCustomAgentBy(id),
      machineCatalogue: () => this.machine,
        onWarning: this.onWarning,
      });
      this.sessions.set(row.id, managed);
      // Every restored row is announced, with no origin: a restart is nobody's act.
      this.announce(managed, "restored", null);
      if (row.exit !== null) continue;

      const orphan = this.runtime.reap(row.agentHandle, row.createdAt, options.reapOrphans ?? true);
      if (orphan.killed) reaped += 1;
      // One status event at lastSeq + 1 explains the outage to a reconnecting client.
      managed.markInterrupted(orphan.confirmedDead, orphan.detail);
      interrupted += 1;
    }

    return { restored: this.sessions.size, interrupted, reaped };
  }

  /** Resumes sessions the daemon ended, most recent first, two at a time; kept out of the synchronous restore so boot is not blocked. */
  async autoResume(options: AutoResumeOptions = {}): Promise<AutoResumeReport> {
    // One pass at a time: a post-update pass queues behind the boot pass (Q4.114).
    const previous = this.resumePass ?? Promise.resolve();
    const run = previous.then(
      () => this.autoResumePass(options),
      () => this.autoResumePass(options),
    );
    this.resumePass = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The pass in flight, so the next one queues behind it. */
  private resumePass: Promise<void> | null = null;

  private async autoResumePass(options: AutoResumeOptions): Promise<AutoResumeReport> {
    const report: AutoResumeReport = { considered: 0, resumed: 0, skipped: 0, failed: 0, deferred: 0 };
    if (!(options.enabled ?? this.autoResumeAllowed)) return report;

    const maxAttempts = options.maxAttempts ?? MAX_RESUME_ATTEMPTS;
    const wait = options.delay ?? delay;
    const random = options.random ?? Math.random;
    const say = options.onOutcome ?? ((): void => {});

    const queue = [...this.sessions.values()]
      .filter(
        (session) =>
          !session.resumeSettled && autoResumable(session.exit, session.agentSessionId, "boot"),
      )
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
    report.considered = queue.length;

    // An agent that cannot resume is asked once per pass.
    const unsupported = new Set<AgentId>();
    let next = 0;

    /** One session, carried through its whole retry budget before the next is taken. */
    const drive = async (session: ManagedSession): Promise<void> => {
      for (;;) {
        // Checked per attempt: a shutdown can land mid-pass.
        if (this.shuttingDown) return;

        if (unsupported.has(session.agent)) {
          session.abandonResume(
            "unsupported",
            "resume_unsupported",
            `${session.agent} cannot reattach to an earlier conversation`,
          );
          report.skipped += 1;
          say({ sessionId: session.id, result: "unsupported", attempt: 0, detail: null });
          return;
        }

        // Checked before resuming: false is settled and never retried, null is a mount that did not answer and is retried.
        const present = await probeExists(session.workspace.root);
        if (present === false) {
          session.abandonResume("workspace_missing", "workspace_missing", `${session.workspace.root} is gone`);
          report.skipped += 1;
          say({ sessionId: session.id, result: "workspace_missing", attempt: 0, detail: null });
          return;
        }

        let failure: { code: string; message: string } | null = null;

        if (present === null) {
          failure = {
            code: "workspace_unresponsive",
            message: `${session.workspace.root} did not answer`,
          };
        } else {
          try {
            // Quiet: nobody asked for this attempt, so no status round trip per try.
            await session.resume(options.timeoutMs ?? START_TIMEOUT_MS, true);
            report.resumed += 1;
            say({
              sessionId: session.id,
              result: "resumed",
              attempt: session.resumeAttemptCount + 1,
              detail: null,
            });
            return;
          } catch (error) {
            const described = describeResumeFailure(error);
            if (error instanceof ResumeUnsupportedError) {
              unsupported.add(session.agent);
              session.abandonResume("unsupported", described.code, described.message);
              report.skipped += 1;
              say({ sessionId: session.id, result: "unsupported", attempt: 0, detail: described.message });
              return;
            }
            // A forgotten conversation is an answer, not a failure: no retry budget spent.
            if (error instanceof SessionForgottenError) {
              session.abandonResume("forgotten", described.code, described.message);
              report.skipped += 1;
              say({ sessionId: session.id, result: "forgotten", attempt: 0, detail: described.message });
              return;
            }
            // Deferred only when installable: other missing-agent causes spend attempts as usual.
            if (error instanceof AgentUnavailableError && error.installable) {
              session.deferResume(described.code, described.message);
              report.deferred += 1;
              say({ sessionId: session.id, result: "agent_missing", attempt: session.resumeAttemptCount, detail: described.message });
              return;
            }
            failure = described;
          }
        }

        const spent = session.noteResumeFailure(failure.code, failure.message);
        if (spent >= maxAttempts) {
          session.abandonResume("attempts_exhausted", failure.code, failure.message);
          report.failed += 1;
          say({ sessionId: session.id, result: "attempts_exhausted", attempt: spent, detail: failure.message });
          return;
        }
        say({ sessionId: session.id, result: "failed", attempt: spent, detail: failure.message });
        // Waited out in the worker rather than requeued, which would need a real clock.
        await wait(resumeBackoffMs(spent, random));
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.shuttingDown) return;
        const session = queue[next++];
        if (session === undefined) return;
        await drive(session);
      }
    };

    const width = Math.max(1, Math.min(options.concurrency ?? RESUME_CONCURRENCY, queue.length));
    await Promise.all(Array.from({ length: width }, () => worker()));
    return report;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** Ends every conversation on the agent, a turn in flight included, and relabels parked ones; returns the count. */
  async signOutSessions(agent: AgentId): Promise<number> {
    // Parked sessions are included: stop relabels them, so they do not wake into a missing credential.
    const live = [...this.sessions.values()].filter(
      (session) =>
        session.agent === agent &&
        (!session.terminal || session.exit?.reason === "parked"),
    );
    // Sequential, to avoid a herd of teardowns on one event loop.
    for (const session of live) {
      await session.stop("agent_signed_out").catch(() => undefined);
    }
    return live.length;
  }

  /** Restarts sessions on the agent without awaiting them; revive also resumes those a sign-out ended. Returns how many will restart. */
  reloadCredentials(agent: AgentId, revive = true): number {
    const mine = [...this.sessions.values()].filter((session) => session.agent === agent);
    const restarting = mine.filter((session) => session.takesCredentialChange);
    // Only a sign-out is reversed, and only when a credential arrived; a manual stop stays stopped.
    const returning = revive
      ? mine.filter((session) => session.terminal && session.exit?.reason === "agent_signed_out")
      : [];

    // Detached so the route answers at once, and sequential so teardowns do not stampede; one failure does not stop the rest.
    void (async () => {
      for (const session of restarting) {
        if (this.shuttingDown) return;
        await session.applyCredentialChange().catch(() => undefined);
      }
      for (const session of returning) {
        // Re-checked: a queued resume may meet a shutdown or a manual stop that happened meanwhile.
        if (this.shuttingDown) return;
        if (!(session.terminal && session.exit?.reason === "agent_signed_out")) continue;
        // A session only parked when signed out goes back to parked instead of spawning.
        if (session.returnToParked()) continue;
        // Quiet, as in autoResumePass: nobody is waiting, so no eviction for this.
        await session.resume(START_TIMEOUT_MS, true).catch(() => undefined);
      }
    })();
    return restarting.length + returning.length;
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Distinct requested cwds, most recent first, for the picker; never worktree paths. */
  recentCwds(limit = 10): string[] {
    const seen: string[] = [];
    for (const session of [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!seen.includes(session.requestedCwd)) seen.push(session.requestedCwd);
      if (seen.length >= limit) break;
    }
    return seen;
  }

  async stop(id: string): Promise<boolean> {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    await managed.stop("stopped");
    return true;
  }

  async resume(id: string): Promise<ManagedSession | undefined> {
    const managed = this.sessions.get(id);
    if (!managed) return undefined;
    await managed.resume();
    return managed;
  }

  /** Stops everything, then kills every group regardless, since a resolved stop proves no child died. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const live = this.list().filter((session) => !session.terminal);
    // Collected before the stops: a clean stop forgets its handle.
    const handles = live
      .map((session) => session.agentHandle)
      .filter((handle): handle is AgentHandle => handle !== null);

    await Promise.race([
      Promise.all(live.map((session) => session.stop("daemon_shutdown").catch(() => {}))),
      delay(SHUTDOWN_BUDGET_MS),
    ]);

    // Parallel and bounded by the same budget as the stops.
    await Promise.race([
      Promise.all(handles.map((handle) => this.runtime.kill(handle, "SIGKILL").catch(() => {}))),
      delay(SHUTDOWN_SWEEP_MS),
    ]);
  }
}

type OptionPick =
  | { kind: "ok"; response: acp.RequestPermissionResponse }
  | { kind: "invalid_option" }
  | { kind: "no_matching_option" };

/** A rejection never degrades into cancelled, which means the turn was abandoned. */
function chooseOption(answer: PermissionAnswer, options: PermissionOptionSummary[]): OptionPick {
  if ("cancel" in answer) return { kind: "ok", response: CANCELLED };

  if ("optionId" in answer) {
    const match = options.find((option) => option.optionId === answer.optionId);
    if (!match) return { kind: "invalid_option" };
    return { kind: "ok", response: { outcome: { outcome: "selected", optionId: match.optionId } } };
  }

  const preference: Record<DecisionWord, PermissionOptionSummary["kind"][]> = {
    allow: ["allow_once", "allow_always"],
    allow_always: ["allow_always", "allow_once"],
    reject: ["reject_once", "reject_always"],
    reject_always: ["reject_always", "reject_once"],
  };
  for (const kind of preference[answer.decision]) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return { kind: "ok", response: { outcome: { outcome: "selected", optionId: match.optionId } } };
    }
  }
  return { kind: "no_matching_option" };
}

/** Validated against the projection sent to the client, never the raw schema; reports every problem. */
export function validateElicitationContent(
  form: ElicitationForm,
  content: Record<string, unknown>,
): ElicitationProblem[] {
  const problems: ElicitationProblem[] = [];
  const byKey = new Map(form.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(content)) {
    if (byKey.has(key)) continue;
    // Refused rather than stripped: a stray key means an outdated client, which must be told.
    problems.push({ key, code: "unknown_field", detail: "this form has no such field" });
  }

  for (const field of form.fields) {
    const present = Object.prototype.hasOwnProperty.call(content, field.key);
    if (!present) {
      if (field.required) {
        problems.push({ key: field.key, code: "missing", detail: "this field is required" });
      }
      continue;
    }
    validateField(field, content[field.key], problems);
  }

  return problems;
}

function validateField(
  field: ElicitationField,
  value: unknown,
  problems: ElicitationProblem[],
): void {
  const bad = (code: ElicitationProblem["code"], detail: string): void => {
    problems.push({ key: field.key, code, detail });
  };

  switch (field.kind) {
    case "string": {
      // Never coerced.
      if (typeof value !== "string") return bad("wrong_type", "expected a string");
      if (value.length > MAX_ELICITATION_ANSWER_CHARS) {
        return bad("too_long", `answers are limited to ${MAX_ELICITATION_ANSWER_CHARS} characters`);
      }
      if (field.options !== null) {
        // By identity against the value we sent: no prefix match, no case folding.
        if (!field.options.some((option) => option.value === value)) {
          return bad("not_an_option", "that is not one of the choices offered");
        }
        return;
      }
      if (field.min !== null && value.length < field.min) {
        return bad("too_short", `at least ${field.min} characters`);
      }
      if (field.max !== null && value.length > field.max) {
        return bad("too_long", `at most ${field.max} characters`);
      }
      // format is deliberately not enforced: the canonical patterns are wrong both ways.
      return;
    }

    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return bad("wrong_type", "expected a number");
      }
      if (field.kind === "integer" && !Number.isInteger(value)) {
        return bad("wrong_type", "expected a whole number");
      }
      if (field.min !== null && value < field.min) return bad("too_small", `at least ${field.min}`);
      if (field.max !== null && value > field.max) return bad("too_large", `at most ${field.max}`);
      return;
    }

    case "boolean":
      if (typeof value !== "boolean") bad("wrong_type", "expected true or false");
      return;

    case "multi_select": {
      if (!Array.isArray(value)) return bad("wrong_type", "expected a list of choices");
      const seen = new Set<string>();
      for (const entry of value) {
        if (typeof entry !== "string") return bad("wrong_type", "expected a list of strings");
        // Refused rather than deduped, which would change the answer silently.
        if (seen.has(entry)) return bad("duplicate", "the same choice was given twice");
        seen.add(entry);
        if (!(field.options ?? []).some((option) => option.value === entry)) {
          return bad("not_an_option", "that is not one of the choices offered");
        }
      }
      if (field.min !== null && value.length < field.min) {
        return bad("too_few", `choose at least ${field.min}`);
      }
      if (field.max !== null && value.length > field.max) {
        return bad("too_many", `choose at most ${field.max}`);
      }
      return;
    }
  }
}

/** Rendered here, while the form is held; value is the chosen option's label, never its wire value. */
function renderAnswers(
  form: ElicitationForm,
  content: Record<string, ElicitationContentValue>,
): ElicitationAnswer[] {
  const answers: ElicitationAnswer[] = [];
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.key)) continue;
    const value = content[field.key];
    const label = (raw: string): string =>
      field.options?.find((option) => option.value === raw)?.label ?? raw;
    const rendered = Array.isArray(value)
      ? value.map(label).join(", ")
      : typeof value === "string"
        ? label(value)
        : String(value);
    if (rendered.length === 0) continue;
    answers.push({ key: field.key, label: field.title ?? field.key, value: rendered });
  }
  return answers;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
