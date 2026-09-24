/** Background work an agent started. ACP has no such concept, so it rides the vendor `jetbrains.air` extension in `_meta` (Q2.228). */

/** Must equal the adapter's module-private constant; pincheck asserts it. */
export const AIR_EXTENSION_VERSION = 1;

export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";

/** Must be in the very first initialize, which the adapter latches; nativeSubagentSessions stays out (Q6.4). */
export const AIR_CLIENT_CAPABILITY = Object.freeze({
  jetbrains: Object.freeze({
    air: Object.freeze({
      version: AIR_EXTENSION_VERSION,
      capabilities: Object.freeze([AIR_ASYNC_TASKS_CAPABILITY]) as readonly string[],
    }),
  }),
});

/** A refusal, not a clip: the id round-trips verbatim to the stop call (Q7.82). */
export const MAX_ASYNC_TASK_ID_CHARS = 256;

export const MAX_ASYNC_TASK_NAME_CHARS = 200;
export const MAX_ASYNC_TASK_TYPE_CHARS = 64;
export const MAX_ASYNC_TASK_TEXT_CHARS = 512;

export const MAX_ASYNC_TASK_PATH_CHARS = 1_024;

/** Past the cap a new id is not tracked; the session is already deferring, so this fails toward parking. */
export const MAX_TRACKED_ASYNC_TASKS = 32;

export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

const STATES: readonly AsyncTaskState[] = ["running", "paused", "completed", "failed", "stopped"];

const TERMINAL: readonly AsyncTaskState[] = ["completed", "failed", "stopped"];

export function isTerminalAsyncTaskState(state: AsyncTaskState): boolean {
  return TERMINAL.includes(state);
}

export interface AsyncTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface AsyncTaskSpawn {
  kind: "spawned";
  asyncTaskId: string;
  name: string;
  taskType: string;
  description: string;
  showInTranscript: boolean;
  canStop: boolean;
  outputFilePath: string | null;
  toolCallId: string | null;
}

export interface AsyncTaskProgress {
  kind: "progress";
  asyncTaskId: string;
  description: string | null;
  summary: string | null;
  lastToolName: string | null;
  usage: AsyncTaskUsage | null;
  outputFilePath: string | null;
  toolCallId: string | null;
}

export interface AsyncTaskTransition {
  kind: "state";
  asyncTaskId: string;
  state: AsyncTaskState;
  summary: string | null;
  outputFilePath: string | null;
  toolCallId: string | null;
}

export type AsyncTaskEdge = AsyncTaskSpawn | AsyncTaskProgress | AsyncTaskTransition;

/** A cheap prefilter: every discriminator starts with it, so other lines skip JSON parsing. */
export const ASYNC_TASK_MARKER = "async_task_";

/** Not in the SDK's SessionUpdate union, so membership is tested outside the switch. */
export const ASYNC_TASK_UPDATES: readonly string[] = [
  "async_task_spawned",
  "async_task_progress",
  "async_task_state_update",
];

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(value: unknown): AsyncTaskUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const totalTokens = count(raw["totalTokens"]);
  const toolUses = count(raw["toolUses"]);
  const durationMs = count(raw["durationMs"]);
  // All three or none: a partial triple would draw a zero nobody measured.
  if (totalTokens === null || toolUses === null || durationMs === null) return null;
  return { totalTokens, toolUses, durationMs };
}

/** Refuses the whole update, never repairs it, so an unreadable state keeps the task live. Cannot throw. */
export function readAsyncTaskEdge(update: unknown): AsyncTaskEdge | null {
  if (typeof update !== "object" || update === null) return null;
  const raw = update as Record<string, unknown>;
  const kind = raw["sessionUpdate"];
  if (typeof kind !== "string" || !ASYNC_TASK_UPDATES.includes(kind)) return null;

  const id = raw["asyncTaskId"];
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ASYNC_TASK_ID_CHARS) return null;

  const outputFilePath = text(raw["outputFilePath"]);
  const toolCallId = text(raw["toolCallId"]);

  if (kind === "async_task_spawned") {
    return {
      kind: "spawned",
      asyncTaskId: id,
      name: text(raw["name"]) ?? "",
      taskType: text(raw["taskType"]) ?? "",
      description: text(raw["description"]) ?? "",
      showInTranscript: flag(raw["showInTranscript"]),
      canStop: flag(raw["canStop"]),
      outputFilePath,
      toolCallId,
    };
  }

  if (kind === "async_task_progress") {
    return {
      kind: "progress",
      asyncTaskId: id,
      description: text(raw["description"]),
      summary: text(raw["summary"]),
      lastToolName: text(raw["lastToolName"]),
      usage: usageOf(raw["usage"]),
      outputFilePath,
      toolCallId,
    };
  }

  const state = raw["state"];
  if (typeof state !== "string" || !STATES.includes(state as AsyncTaskState)) return null;
  return {
    kind: "state",
    asyncTaskId: id,
    state: state as AsyncTaskState,
    summary: text(raw["summary"]),
    outputFilePath,
    toolCallId,
  };
}

function airMeta(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "object" || meta === null) return null;
  const jetbrains = (meta as Record<string, unknown>)["jetbrains"];
  if (typeof jetbrains !== "object" || jetbrains === null) return null;
  const air = (jetbrains as Record<string, unknown>)["air"];
  if (typeof air !== "object" || air === null || Array.isArray(air)) return null;
  return air as Record<string, unknown>;
}

/** A capability test: false means the agent never said, not that nothing runs. */
export function agentAdvertisesAsyncTasks(meta: unknown): boolean {
  const air = airMeta(meta);
  if (air === null) return false;
  const version = air["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < AIR_EXTENSION_VERSION) {
    return false;
  }
  const advertised = air["capabilities"];
  return Array.isArray(advertised) && advertised.includes(AIR_ASYNC_TASKS_CAPABILITY);
}

/** Whether a tool call detached into the background, so its card must not read as finished (Q3.592). */
export function readBackgroundedMarker(meta: unknown): boolean {
  const air = airMeta(meta);
  if (air === null) return false;
  const asyncTasks = air[AIR_ASYNC_TASKS_CAPABILITY];
  if (typeof asyncTasks !== "object" || asyncTasks === null) return false;
  return flag((asyncTasks as Record<string, unknown>)["backgrounded"]);
}

export interface BackgroundTask {
  /** The agent's own id, verbatim — what `_session/async_task/stop` takes back. */
  id: string;
  name: string;
  taskType: string;
  description: string;
  state: AsyncTaskState;
  summary: string | null;
  lastToolName: string | null;
  usage: AsyncTaskUsage | null;
  canStop: boolean;
  showInTranscript: boolean;
  outputFilePath: string | null;
  toolCallId: string | null;
  startedAt: number;
  /** Stamped here, since the adapter sends no end time; kept across terminal relabels, cleared if running again. */
  endedAt: number | null;
}
