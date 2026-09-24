import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpClient,
  type ElicitationRequest,
  type NotificationListener,
  type SessionHandlers,
} from "./acp/client.js";
import type { AsyncTaskEdge, BackgroundTask } from "./acp/asynctasks.js";
import {
  ASYNC_TASK_UPDATES,
  MAX_ASYNC_TASK_NAME_CHARS,
  MAX_ASYNC_TASK_PATH_CHARS,
  MAX_ASYNC_TASK_TEXT_CHARS,
  MAX_ASYNC_TASK_TYPE_CHARS,
  MAX_TRACKED_ASYNC_TASKS,
  byLiveThenNewest,
  isTerminalAsyncTaskState,
  readAsyncTaskEdge,
  readBackgroundedMarker,
} from "./acp/asynctasks.js";
import { MAX_PARENT_ID_CHARS, toolCallLineage } from "./acp/subagents.js";
import {
  mcpElicitResponse,
  mcpElicitation,
  planPermission,
  planResponse,
  questionElicitation,
  questionResponse,
  type XaiMcpElicitRequest,
  type XaiMcpElicitResponse,
  type XaiPlanRequest,
  type XaiPlanResponse,
  type XaiQuestionRequest,
  type XaiQuestionResponse,
} from "./acp/xai.js";
import { sessionMetaFor } from "./acp/agents.js";
import type { AgentRouting } from "./acp/systems.js";
import {
  BUILTIN_CATALOGUE,
  hostable,
  routedModelEnv,
  routedPairing,
  routingHeaders,
  type MachineCatalogue,
  type SystemId,
} from "./acp/systems.js";
import type { AgentId } from "./acp/agents.js";
import { clip, jsonBytes } from "./events.js";
import type {
  AgentCommand,
  AgentCommands,
  StoredFileRef,
  AgentConfig,
  AgentConfigChoice,
  AgentConfigOption,
  AgentModes,
  ContextUsage,
  ElicitationField,
  ElicitationForm,
  ElicitationOption,
  FileLocation,
  PermissionOptionSummary,
  SessionEvent,
} from "./events.js";
import { LocalRuntime } from "./runtime/local.js";
import type { AgentHandle, SessionRuntime } from "./runtime/types.js";
import { describeError } from "./http.js";

const AUTH_REQUIRED = -32000;
// On resume: the agent no longer has the conversation. Matched by code, not message.
const RESOURCE_NOT_FOUND = -32002;
const INTERNAL_ERROR = -32603;
const CANCEL_GRACE_MS = 5_000;
const CANCEL_SEND_TIMEOUT_MS = 1_000;
const CANCEL_SETTLE_MS = 1_500;
const CLOSE_TIMEOUT_MS = 2_000;
// ACP extension injecting into the running turn; the original session/prompt still resolves exactly once.
const STEER_METHOD = "_session/steering";

// Stops one background task without cancelling the turn; `{stopped: false}` means it already finished.
const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

const ASYNC_TASK_STOP_TIMEOUT_MS = 10_000;
// A timeout here can duplicate a message if the caller then queues it.
const STEER_TIMEOUT_MS = 10_000;

/** `started_new_turn` is a failure: that turn has no session/prompt for pump to close. */
export type SteerOutcome = "injected" | "started_new_turn" | "prompt_required" | "unsupported";

// claude-agent-acp stamps the usage_update after every SDK result with the cycle's origin; the one end a cycle nobody prompted has (Q2.233).
const CYCLE_ORIGIN_META = "_claude/origin";

function marksCycleEnd(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  const origin = (meta as Record<string, unknown>)[CYCLE_ORIGIN_META];
  return typeof origin === "object" && origin !== null;
}

const NEW_SESSION_TIMEOUT_MS = 15_000;
// Bounds the launch RPC: unbounded, a wedged agent leaks its process, worktree and session slot.
const LAUNCH_SESSION_TIMEOUT_MS = 60_000;
const SET_CONFIG_TIMEOUT_MS = 15_000;
// The name cap refuses (a clipped name is a broken command); the others truncate.
const MAX_AGENT_COMMANDS = 256;
const MAX_COMMAND_NAME_CHARS = 64;
const MAX_COMMAND_DESCRIPTION_CHARS = 200;
const MAX_COMMAND_HINT_CHARS = 100;

// Structure is refused, prose is carried whole (no MAX_ELICITATION_TITLE_CHARS clip); MAX_ELICITATION_FORM_BYTES bounds the total.
const MAX_ELICITATION_FIELDS = 24;
const MAX_ELICITATION_OPTIONS = 24;
const MAX_ELICITATION_FORM_BYTES = 32 * 1024;
const MAX_ELICITATION_VALUE_CHARS = 512;

// `message` is outside the form's byte backstop, so it is clipped here or one preamble stalls the stream.
const MAX_ELICITATION_MESSAGE_CHARS = 4 * 1024;
const MAX_BUFFERED_EVENTS = 2_000;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

const MAX_IMAGES_PER_UPDATE = 8;

// Refused, never clipped: a MAX_PERMISSION_OPTION_NAME_CHARS clip broke kimi's identity match; {title, options} is weighed as one whole.
const MAX_PERMISSION_OPTIONS = 24;
const MAX_PERMISSION_OPTION_ID_CHARS = 256;
const MAX_PERMISSION_SNAPSHOT_BYTES = 8 * 1024;

const MAX_TOOL_LOCATIONS = 64;
const MAX_TOOL_LOCATION_CHARS = 1_024;

export interface PendingPermission {
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  // Often the only copy of the arguments (kimi's tool_call has none); bounded at the registry.
  rawInput: unknown;
  content: unknown;
}

/** May stay parked indefinitely; `signal` aborts when the request is withdrawn or the connection dies. */
export type PermissionResolver = (
  request: PendingPermission,
  signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse>;

export interface PendingElicitation {
  toolCallId: string | null;
  message: string;
  form: ElicitationForm;
}

/** No local fallback: without a resolver the capability is never declared, since a question has no default answer. */
export type ElicitationResolver = (
  request: PendingElicitation,
  signal: AbortSignal,
) => Promise<acp.CreateElicitationResponse>;

export interface SessionOptions {
  agent: AgentId;
  cwd: string;
  permissions?: PermissionResolver;
  // Its presence declares the elicitation capability.
  elicitations?: ElicitationResolver | null;
  runtime?: SessionRuntime;
  // Synchronous: called from the agent's notification handler.
  keepImage?: (mime: string, data: string) => StoredFileRef | null;
  ultracode?: boolean;
  // A SystemId, never a URL: only acp/systems.ts decides what reaches the wire.
  system?: SystemId | null;
  model?: string | null;
  // Passed in, never read from a module (Q2.215). Absent means BUILTIN_CATALOGUE.
  machine?: MachineCatalogue | null;
}

export interface ResumeOptions extends SessionOptions {
  agentSessionId: string;
}

export class SessionForgottenError extends Error {
  constructor(
    displayName: string,
    readonly agentSessionId: string,
  ) {
    super(
      `${displayName} no longer has the conversation ${agentSessionId}. The transcript here ` +
        "is intact, but the agent cannot be put back on it.",
    );
    this.name = "SessionForgottenError";
  }
}

/** No fallback: an agent that cannot reach the requested system must not run on its own default. */
export class SystemRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemRoutingError";
  }
}

export class ResumeUnsupportedError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} does not support session/resume. The session's transcript is intact, ` +
        "but this agent cannot be reattached to it.",
    );
    this.name = "ResumeUnsupportedError";
  }
}

export class Session {
  private readonly queue = new EventQueue();
  private readonly diffedToolCalls = new Set<string>();
  private unregister: (() => void) | null = null;
  private unsubscribeLogs: (() => void) | null = null;
  private turnActive = false;
  // Fences a prompt's callbacks: abandonTurn bumps it, so a late settle neither ends a newer turn nor clears turnActive.
  private promptEpoch = 0;
  private disposed: Promise<void> | null = null;
  private config: AgentConfig = { modes: null, options: [] };
  private readonly configListeners = new Set<(config: AgentConfig) => void>();
  private usage: ContextUsage | null = null;
  private readonly usageListeners = new Set<(usage: ContextUsage) => void>();
  private agentNumbersMessages = false;
  private unnumberedMessages = 0;
  // Out of band: logging task edges would move lastEventAt and defer the idle sweep.
  private readonly asyncTasks = new Map<string, BackgroundTask>();
  private readonly asyncTaskListeners = new Set<(tasks: readonly BackgroundTask[]) => void>();
  private commandState: AgentCommands = { commands: [], dropped: 0 };
  private readonly commandListeners = new Set<(commands: AgentCommands) => void>();
  // Latched by the first cycle end: an agent that never marks one is never tracked, so nothing can strand it reading as working (Q2.233).
  private marksCycleEnds = false;
  private unpromptedSinceValue: number | null = null;
  private readonly unpromptedListeners = new Set<(since: number | null) => void>();
  // grok's requests in flight, by the call id its interaction_resolved names (Q6.113).
  private readonly xaiInFlight = new Map<string, AbortController>();

  private cwd = "";

  private sessionMeta: Record<string, unknown> | undefined;

  private constructor(
    readonly agent: AgentId,
    public sessionId: string,
    private readonly client: AcpClient,
    private readonly permissions: PermissionResolver | null,
    private readonly elicitations: ElicitationResolver | null,
    private readonly keepImage: ((mime: string, data: string) => StoredFileRef | null) | undefined,
  ) {}

  get exited(): Promise<void> {
    return this.client.closed;
  }

  /** Runs /clear as a fresh session/new on the same process: forwarded, claude forks to a conversation we never learn of. */
  async clearContext(): Promise<{ previous: string; next: string; abandonedTasks: number }> {
    const previous = this.sessionId;
    const opened = await withDeadline(
      this.client.agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: [],
        ...metaParam(this.sessionMeta),
      }),
      NEW_SESSION_TIMEOUT_MS,
      "session/new (clear)",
    );

    const next = opened.sessionId;
    this.unregister?.();
    this.sessionId = next;
    this.unregister = this.client.registerSession(next, this.handlers());

    // Drop the old conversation's tasks after the re-key: their updates are now unroutable, and a stale running row blocks parking for ever.
    const abandonedTasks = [...this.asyncTasks.values()].filter(
      (task) => !isTerminalAsyncTaskState(task.state),
    ).length;
    this.asyncTasks.clear();
    this.announceAsyncTasks();
    // The old conversation's cycle end is unroutable now too.
    this.setUnprompted(null);

    const wanted = this.config;
    this.config = {
      modes: toModes(opened.modes),
      options: toConfigOptions(opened.configOptions),
    };

    if (this.client.supportsSessionClose()) {
      await withDeadline(
        this.client.agent.request(acp.methods.agent.session.close, { sessionId: previous }),
        CLOSE_TIMEOUT_MS,
        "session/close (clear)",
      ).catch(() => {});
    }

    await this.restoreConfig(wanted);
    return { previous, next, abandonedTasks };
  }

  /** Re-applies only what differs and the new conversation still offers; failures are swallowed. */
  async restoreConfig(wanted: AgentConfig): Promise<void> {
    for (const option of wanted.options) {
      const now = this.config.options.find((candidate) => candidate.id === option.id);
      if (now === undefined || now.value === option.value) continue;
      if (now.kind === "select" && !now.choices.some((c) => c.value === option.value)) continue;
      await this.setConfigOption(option.id, option.value).catch(() => {});
    }
    const mode = wanted.modes?.current;
    if (mode === undefined || this.config.modes === null || this.config.modes.current === mode) return;
    if (!this.config.modes.available.some((available) => available.id === mode)) return;
    await this.setMode(mode).catch(() => {});
  }

  get handle(): AgentHandle | null {
    return this.client.handle;
  }

  get agentConfig(): AgentConfig {
    return this.config;
  }

  routing(): Promise<AgentRouting | null> {
    return this.client.routing();
  }

  get modelOption(): AgentConfigOption | null {
    return this.config.options.find((one) => one.category === "model") ?? null;
  }

  onConfigChanged(listener: (config: AgentConfig) => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  get contextUsage(): ContextUsage | null {
    return this.usage;
  }

  onUsageChanged(listener: (usage: ContextUsage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  get backgroundTasks(): readonly BackgroundTask[] {
    return [...this.asyncTasks.values()].sort(byLiveThenNewest);
  }

  get reportsBackgroundTasks(): boolean {
    return this.client.supportsAsyncTasks();
  }

  onBackgroundTasksChanged(listener: (tasks: readonly BackgroundTask[]) => void): () => void {
    this.asyncTaskListeners.add(listener);
    return () => this.asyncTaskListeners.delete(listener);
  }

  /** When the agent began working with no prompt of ours in flight, or null (Q2.233). */
  get unpromptedSince(): number | null {
    return this.unpromptedSinceValue;
  }

  onUnpromptedChanged(listener: (since: number | null) => void): () => void {
    this.unpromptedListeners.add(listener);
    return () => this.unpromptedListeners.delete(listener);
  }

  /** The daemon's own ending, for a cycle whose end never arrived; the agent is told nothing. */
  endUnprompted(): void {
    this.setUnprompted(null);
  }

  awaitUnpromptedEnd(timeoutMs: number = CANCEL_SETTLE_MS): Promise<boolean> {
    return this.waitUntil(() => this.unpromptedSinceValue === null, timeoutMs);
  }

  // Set on arrival, in onUpdate's order, never from the idle drain: a drain behind the end marker would light it again.
  private noteAgentWork(): void {
    if (this.turnActive || !this.marksCycleEnds || this.unpromptedSinceValue !== null) return;
    this.setUnprompted(Date.now());
  }

  private setUnprompted(next: number | null): void {
    if (this.unpromptedSinceValue === next) return;
    this.unpromptedSinceValue = next;
    for (const listener of this.unpromptedListeners) {
      try {
        listener(next);
      } catch {
        // Same guard as updateConfig.
      }
    }
  }

  get agentCommands(): AgentCommands {
    return this.commandState;
  }

  get acceptsImages(): boolean {
    return this.client.acceptsImages();
  }

  onCommandsChanged(listener: (commands: AgentCommands) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  recentLogs(): string[] {
    return this.client.recentLogs();
  }

  onRawUpdate(listener: NotificationListener): () => void {
    return this.client.onNotification(listener);
  }

  static async start(options: SessionOptions): Promise<Session> {
    if (!isAbsolute(options.cwd)) {
      throw new Error(`cwd must be an absolute path, got "${options.cwd}"`);
    }

    const runtime = options.runtime ?? new LocalRuntime();
    const config = runtime.describe(options.agent);
    const pairing = routedPairing(
      options.agent,
      options.system ?? null,
      options.machine ?? BUILTIN_CATALOGUE,
    );
    const client = await AcpClient.launch(
      config,
      await runtime.launch(options.agent, spawnEnvOf(options), pairing),
      {
        fileIo: runtime.clientFileIo,
        elicitation: options.elicitations != null,
        authMethod: runtime.authMethod(options.agent, pairing),
      },
    );

    let routed: boolean;
    try {
      routed = await applySystem(client, options, runtime);
    } catch (error) {
      await client.close();
      throw error;
    }

    let response: acp.NewSessionResponse;
    try {
      response = await withDeadline(
        client.agent.request(acp.methods.agent.session.new, {
          cwd: options.cwd,
          mcpServers: [],
          ...metaParam(sessionMetaOf(options)),
        }),
        LAUNCH_SESSION_TIMEOUT_MS,
        "session/new",
      );
    } catch (error) {
      await client.close();
      if (isAuthRequired(error)) {
        const message = `${config.displayName} rejected session/new: authentication required.\n${config.authHint}`;
        // Recorded here and in openResumed only; mid-turn authentication_failed is onAgentUnusable's (Q7.99).
        runtime.noteStartRefusal(options.agent, message, routed);
        throw new Error(message);
      }
      throw error;
    }

    runtime.forgetStartRefusal(options.agent);

    const session = Session.adopt(options, client, response.sessionId, response);
    try {
      const unpinned = await pinNativeModel(session, options);
      if (unpinned !== null) throw new SystemRoutingError(unpinned);
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return session;
  }

  /** Uses session/resume, never session/load, which would replay history already in the log. */
  static async resume(options: ResumeOptions): Promise<Session> {
    const runtime = options.runtime ?? new LocalRuntime();
    try {
      return await Session.openResumed(options, runtime.clientFileIo);
    } catch (error) {
      // One retry without fs, only for -32603: kimi cannot resume a plan-mode session with fs declared.
      if (!runtime.clientFileIo || !hasRpcCode(error, INTERNAL_ERROR)) throw error;
      return await Session.openResumed(options, false);
    }
  }

  private static async openResumed(options: ResumeOptions, fileIo: boolean): Promise<Session> {
    if (!isAbsolute(options.cwd)) {
      throw new Error(`cwd must be an absolute path, got "${options.cwd}"`);
    }

    const runtime = options.runtime ?? new LocalRuntime();
    const config = runtime.describe(options.agent);
    const pairing = routedPairing(
      options.agent,
      options.system ?? null,
      options.machine ?? BUILTIN_CATALOGUE,
    );
    const client = await AcpClient.launch(
      config,
      await runtime.launch(options.agent, spawnEnvOf(options), pairing),
      {
        fileIo,
        elicitation: options.elicitations != null,
        authMethod: runtime.authMethod(options.agent, pairing),
      },
    );

    // Re-applied on every resume: routing lives in the agent process.
    let routed: boolean;
    try {
      routed = await applySystem(client, options, runtime);
    } catch (error) {
      await client.close();
      throw error;
    }

    if (!client.supportsSessionResume()) {
      await client.close();
      throw new ResumeUnsupportedError(config.displayName);
    }

    let response: acp.ResumeSessionResponse;
    try {
      response = await withDeadline(
        client.agent.request(acp.methods.agent.session.resume, {
          sessionId: options.agentSessionId,
          cwd: options.cwd,
          mcpServers: [],
          ...metaParam(sessionMetaOf(options)),
        }),
        LAUNCH_SESSION_TIMEOUT_MS,
        "session/resume",
      );
    } catch (error) {
      await client.close();
      if (isAuthRequired(error)) {
        const message = `${config.displayName} rejected session/resume: authentication required.\n${config.authHint}`;
        runtime.noteStartRefusal(options.agent, message, routed);
        throw new Error(message);
      }
      if (hasRpcCode(error, RESOURCE_NOT_FOUND)) {
        throw new SessionForgottenError(config.displayName, options.agentSessionId);
      }
      throw error;
    }

    runtime.forgetStartRefusal(options.agent);

    const session = Session.adopt(options, client, options.agentSessionId, response);

    // For a native pairing this is the only pin on resume (Q2.215); it demotes rather than refuses (Q2.216).
    let unpinned: string | null;
    try {
      unpinned = await pinNativeModel(session, options);
    } catch (error) {
      unpinned =
        `${options.agent} would not put this conversation back on ` +
        `${JSON.stringify(options.model ?? "")} (${describeError(error)}).`;
    }
    if (unpinned !== null) {
      const current = session.modelOption?.value;
      const running =
        typeof current === "string" && current !== "" ? `running ${current}` : "running this agent's own default";
      session.queue.push({
        type: "error",
        message: `${unpinned} The conversation was resumed anyway, ${running}.`,
        data: { code: "model_not_pinned", model: options.model ?? null },
      });
    }
    return session;
  }

  private static adopt(
    options: SessionOptions,
    client: AcpClient,
    sessionId: string,
    opened: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null },
    ): Session {
    const session = new Session(
      options.agent,
      sessionId,
      client,
      options.permissions ?? null,
      options.elicitations ?? null,
      options.keepImage,
    );
    session.cwd = options.cwd;
    session.sessionMeta = sessionMetaOf(options);
    session.unregister = client.registerSession(sessionId, session.handlers());
    session.unsubscribeLogs = client.onLog((line) => {
      session.queue.push({ type: "agent_log", line });
    });

    // Read both: kimi fills only configOptions.
    session.config = {
      modes: toModes(opened.modes),
      options: toConfigOptions(opened.configOptions),
    };

    const info = client.initializeResult.agentInfo;
    session.queue.push({
      type: "session_started",
      agent: options.agent,
      sessionId,
      agentInfo: info ? { name: info.name, version: info.version } : null,
      modes: session.config.modes,
    });

    return session;
  }

  /** Answers the agent's refreshed config: setting one knob can change others. */
  async setConfigOption(configId: string, value: string | boolean): Promise<AgentConfig> {
    return this.queueConfig(() => this.sendConfigOption(configId, value));
  }

  // Unqueued: public methods queue and send* must not, or setMode waits on its own slot.
  private async sendConfigOption(configId: string, value: string | boolean): Promise<AgentConfig> {
    const response = await withDeadline(
      this.client.agent.request(
        acp.methods.agent.session.setConfigOption,
        typeof value === "boolean"
          ? { sessionId: this.sessionId, configId, type: "boolean", value }
          : { sessionId: this.sessionId, configId, value },
      ),
      SET_CONFIG_TIMEOUT_MS,
      `session/set_config_option (${configId})`,
    );
    this.updateConfig({ options: toConfigOptions(response.configOptions) });
    return this.config;
  }

  async setMode(modeId: string): Promise<AgentConfig> {
    return this.queueConfig(() => this.sendMode(modeId));
  }

  private async sendMode(modeId: string): Promise<AgentConfig> {
    const option = this.config.options.find((candidate) => candidate.category === "mode");
    if (option !== undefined && option.kind === "select") {
      return this.sendConfigOption(option.id, modeId);
    }
    await withDeadline(
      this.client.agent.request(acp.methods.agent.session.setMode, {
        sessionId: this.sessionId,
        modeId,
      }),
      SET_CONFIG_TIMEOUT_MS,
      `session/set_mode (${modeId})`,
    );
    this.updateConfig({ currentModeId: modeId });
    return this.config;
  }

  // Never rejects, or one refusal kills every later change.
  private configChain: Promise<void> = Promise.resolve();

  // Serialized: options are replaced wholesale, so overlapping responses would corrupt the held state.
  private queueConfig(run: () => Promise<AgentConfig>): Promise<AgentConfig> {
    const result = this.configChain.then(run, run);
    this.configChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private updateConfig(change: { options?: AgentConfigOption[]; currentModeId?: string }): void {
    let modes = this.config.modes;
    let options = change.options ?? this.config.options;

    if (change.currentModeId !== undefined) {
      const modeId = change.currentModeId;
      // Ignored, not clipped: a clipped id selects nothing, and unbounded it stalls the stream.
      if (modeId.length > MAX_CONFIG_ID_CHARS) return;
      if (modes !== null) modes = { ...modes, current: modeId };
      options = options.map((option) =>
        option.category === "mode" && option.kind === "select" && option.choices.some((c) => c.value === modeId)
          ? { ...option, value: modeId }
          : option,
      );
    } else if (change.options !== undefined && modes !== null) {
      const current = options.find((option) => option.category === "mode" && option.kind === "select");
      if (
        current !== undefined &&
        typeof current.value === "string" &&
        current.value !== modes.current &&
        modes.available.some((mode) => mode.id === current.value)
      ) {
        modes = { ...modes, current: current.value };
      }
    }

    this.config = { modes, options };
    for (const listener of this.configListeners) {
      try {
        listener(this.config);
      } catch {
        // A broken listener must not stop the others or reach the agent's notification handler.
      }
    }
  }

  private updateCommands(commands: AgentCommands): void {
    this.commandState = commands;
    for (const listener of this.commandListeners) {
      try {
        listener(this.commandState);
      } catch {
        // Same guard as updateConfig.
      }
    }
  }

  // An invalid update is dropped whole so the last good reading survives.
  private updateUsage(update: acp.UsageUpdate): void {
    const used = Number(update.used);
    const size = Number(update.size);
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(size)) return;

    const rawCost = update.cost as { amount?: unknown; currency?: unknown } | null | undefined;
    const amount = Number(rawCost?.amount);
    const cost =
      rawCost && Number.isFinite(amount) && typeof rawCost.currency === "string"
        ? { amount, currency: rawCost.currency.slice(0, 8) }
        : null;

    this.usage = { used, size: size > 0 ? size : 0, cost };
    for (const listener of this.usageListeners) {
      try {
        listener(this.usage);
      } catch {
        // Same guard as updateConfig.
      }
    }
  }

  // After the agent's first messageId, an unnumbered chunk is its own message with a `~` id (Q3.604).
  private messageIdFor(sent: unknown): string | null {
    const given = typeof sent === "string" ? sent.slice(0, MAX_MESSAGE_ID_CHARS) : "";
    if (given.length > 0) {
      this.agentNumbersMessages = true;
      return given;
    }
    if (!this.agentNumbersMessages) return null;
    this.unnumberedMessages += 1;
    return `~${this.unnumberedMessages}`;
  }

  private applyAsyncTaskEdge(edge: AsyncTaskEdge): void {
    if (edge.kind === "spawned") {
      // Evict a finished row before refusing a running one, or the sweep releases an agent mid-build.
      if (
        !this.asyncTasks.has(edge.asyncTaskId) &&
        this.asyncTasks.size >= MAX_TRACKED_ASYNC_TASKS &&
        !this.evictFinishedTask()
      ) {
        return;
      }
      // A repeat spawn keeps the row's lifecycle and refreshes only its description.
      const known = this.asyncTasks.get(edge.asyncTaskId);
      if (known !== undefined) {
        this.asyncTasks.set(edge.asyncTaskId, {
          ...known,
          name: clip(edge.name, MAX_ASYNC_TASK_NAME_CHARS),
          taskType: clip(edge.taskType, MAX_ASYNC_TASK_TYPE_CHARS),
          description: clip(edge.description, MAX_ASYNC_TASK_TEXT_CHARS),
          canStop: edge.canStop,
          showInTranscript: edge.showInTranscript,
          outputFilePath:
            (edge.outputFilePath && clip(edge.outputFilePath, MAX_ASYNC_TASK_PATH_CHARS)) ??
            known.outputFilePath,
          toolCallId: (edge.toolCallId && clip(edge.toolCallId, MAX_PARENT_ID_CHARS)) ?? known.toolCallId,
        });
        this.announceAsyncTasks();
        return;
      }
      this.asyncTasks.set(edge.asyncTaskId, {
        id: edge.asyncTaskId,
        name: clip(edge.name, MAX_ASYNC_TASK_NAME_CHARS),
        taskType: clip(edge.taskType, MAX_ASYNC_TASK_TYPE_CHARS),
        description: clip(edge.description, MAX_ASYNC_TASK_TEXT_CHARS),
        state: "running",
        summary: null,
        lastToolName: null,
        usage: null,
        canStop: edge.canStop,
        showInTranscript: edge.showInTranscript,
        outputFilePath: edge.outputFilePath && clip(edge.outputFilePath, MAX_ASYNC_TASK_PATH_CHARS),
        toolCallId: edge.toolCallId && clip(edge.toolCallId, MAX_PARENT_ID_CHARS),
        startedAt: Date.now(),
        endedAt: null,
      });
      this.announceAsyncTasks();
      return;
    }

    const held = this.asyncTasks.get(edge.asyncTaskId);
    if (held === undefined) return;

    const merged: BackgroundTask = {
      ...held,
      outputFilePath:
        (edge.outputFilePath && clip(edge.outputFilePath, MAX_ASYNC_TASK_PATH_CHARS)) ??
        held.outputFilePath,
      toolCallId: (edge.toolCallId && clip(edge.toolCallId, MAX_PARENT_ID_CHARS)) ?? held.toolCallId,
      summary: (edge.summary && clip(edge.summary, MAX_ASYNC_TASK_TEXT_CHARS)) ?? held.summary,
    };
    if (edge.kind === "progress") {
      merged.description =
        (edge.description && clip(edge.description, MAX_ASYNC_TASK_TEXT_CHARS)) ?? held.description;
      merged.lastToolName =
        (edge.lastToolName && clip(edge.lastToolName, MAX_ASYNC_TASK_TYPE_CHARS)) ?? held.lastToolName;
      merged.usage = edge.usage ?? held.usage;
    } else {
      merged.state = edge.state;
      // A terminal relabelling keeps the first end; a return to running clears it.
      merged.endedAt = isTerminalAsyncTaskState(edge.state) ? (held.endedAt ?? Date.now()) : null;
    }

    this.asyncTasks.set(edge.asyncTaskId, merged);
    this.announceAsyncTasks();
  }

  private evictFinishedTask(): boolean {
    let oldest: BackgroundTask | null = null;
    for (const task of this.asyncTasks.values()) {
      if (!isTerminalAsyncTaskState(task.state)) continue;
      const ended = task.endedAt ?? task.startedAt;
      if (oldest === null || ended < (oldest.endedAt ?? oldest.startedAt)) oldest = task;
    }
    if (oldest === null) return false;
    this.asyncTasks.delete(oldest.id);
    return true;
  }

  private announceAsyncTasks(): void {
    const tasks = this.backgroundTasks;
    for (const listener of this.asyncTaskListeners) {
      try {
        listener(tasks);
      } catch {
        // Same guard as updateUsage.
      }
    }
  }

  async *prompt(
    text: string,
    extra: readonly acp.ContentBlock[] = [],
  ): AsyncGenerator<SessionEvent, void, void> {
    if (this.turnActive) {
      throw new Error("a prompt is already in flight for this session");
    }
    this.turnActive = true;

    // Claim before firing, with no await between, so the idle drain never takes this turn's turn_end.
    const claim = this.queue.claimForTurn();

    const epoch = (this.promptEpoch += 1);

    void this.client.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: text.length === 0 ? [...extra] : [{ type: "text", text }, ...extra],
      })
      .then(
        (response) => {
          if (this.promptEpoch !== epoch) return;
          this.flushToolDraft();
          // The agent runs its input in order, so every cycle begun before this prompt has ended by now.
          this.setUnprompted(null);
          this.queue.push({
            type: "turn_end",
            stopReason: response.stopReason,
            usage: response.usage ?? null,
          });
        },
        (error: unknown) => {
          if (this.promptEpoch !== epoch) return;
          this.flushToolDraft();
          this.setUnprompted(null);
          this.queue.push({
            type: "error",
            message: describeError(error),
            data: error instanceof acp.RequestError ? { code: error.code, data: error.data } : null,
          });
        },
      )
      .finally(() => {
        // Fenced: after an abandonment a newer prompt may own turnActive.
        if (this.promptEpoch === epoch) this.turnActive = false;
      });

    try {
      for (;;) {
        const event = await this.queue.next(claim);
        // Displaced by a newer prompt; the release below is identity-checked.
        if (event === null) return;
        yield event;
        if (event.type === "turn_end" || event.type === "error") return;
      }
    } finally {
      this.queue.release(claim);
    }
  }

  /** Reads events outside a turn; a starting prompt displaces it. Only ManagedSession attaches one. */
  drainBetweenTurns(onEvent: (event: SessionEvent) => void): void {
    const claim = this.queue.claimForIdle();
    if (claim === null) return;
    void (async () => {
      for (;;) {
        const event = await this.queue.next(claim);
        // CLOSED answers for ever, so carrying on would spin.
        if (event === null || event === CLOSED) return;
        try {
          onEvent(event);
        } catch {
          // Keep the listener: it is this session's only consumer.
        }
      }
    })();
  }

  /** Asks, never forces. Parked permissions must be answered before the turn can end. */
  async cancelTurn(): Promise<void> {
    await this.sendCancel();
  }

  awaitTurnEnd(timeoutMs: number = CANCEL_SETTLE_MS): Promise<boolean> {
    return this.waitForTurnToSettle(timeoutMs);
  }

  get supportsSteering(): boolean {
    return this.client.supportsSteering();
  }

  /** `promptRequired` is mandatory: an idle steer would start a turn pump cannot close. */
  async steer(text: string, extra: readonly acp.ContentBlock[] = []): Promise<SteerOutcome> {
    if (!this.supportsSteering) return "unsupported";

    let answer: unknown;
    try {
      answer = await withAbandonableDeadline(
        (options) =>
          this.client.agent.request<unknown, unknown>(
            STEER_METHOD,
            {
              sessionId: this.sessionId,
              prompt: text.length === 0 ? [...extra] : [{ type: "text", text }, ...extra],
              _meta: { steering: { idleBehavior: "promptRequired" } },
            },
            options,
          ),
        STEER_TIMEOUT_MS,
        `${this.client.config.displayName} taking a message into the running turn`,
      );
    } catch {
      return "unsupported";
    }

    const outcome =
      answer !== null && typeof answer === "object"
        ? (answer as Record<string, unknown>)["outcome"]
        : undefined;
    if (outcome === "startedNewTurn") return "started_new_turn";
    if (outcome === "promptRequired") return "prompt_required";
    return "injected";
  }

  /** `false` means the task already finished, never an error. */
  async stopAsyncTask(asyncTaskId: string): Promise<boolean> {
    const answer = await withAbandonableDeadline(
      (options) =>
        this.client.agent.request<unknown, unknown>(
          ASYNC_TASK_STOP_METHOD,
          { sessionId: this.sessionId, asyncTaskId },
          options,
        ),
      ASYNC_TASK_STOP_TIMEOUT_MS,
      `${this.client.config.displayName} stopping a background task`,
    );
    return (
      answer !== null && typeof answer === "object" && (answer as Record<string, unknown>)["stopped"] === true
    );
  }

  private sendCancel(): Promise<void> {
    return withTimeout(
      this.client.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.sessionId,
      }),
      CANCEL_SEND_TIMEOUT_MS,
    );
  }

  /** Ends this daemon's claim of a turn without telling the agent (Q2.42). */
  abandonTurn(): boolean {
    if (!this.turnActive) return false;
    this.promptEpoch += 1;
    this.turnActive = false;
    this.flushToolDraft();
    this.queue.push({ type: "turn_end", stopReason: "abandoned", usage: null });
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed ??= this.doDispose();
    return this.disposed;
  }

  private async doDispose(): Promise<void> {
    // Bounded: a wedged agent would otherwise park the kill path. Cancel unconditionally, as turnActive clears early.
    try {
      await this.sendCancel();
      if (this.turnActive) await this.waitForTurnToSettle(CANCEL_GRACE_MS);
    } catch {
      // The connection may already be gone; the kill path below still runs.
    }

    if (this.client.supportsSessionClose()) {
      try {
        await withTimeout(
          this.client.agent.request(acp.methods.agent.session.close, {
            sessionId: this.sessionId,
          }),
          CLOSE_TIMEOUT_MS,
        );
      } catch {
        // Best effort — closing stdin ends the session either way.
      }
    }

    this.unregister?.();
    this.unsubscribeLogs?.();
    this.flushToolDraft();
    // CLOSED is the only thing that ends the idle drain, and dispose() memoises.
    try {
      await this.client.close();
    } finally {
      this.queue.close();
    }
  }

  private handlers(): SessionHandlers {
    return {
      onUpdate: (notification) => this.onUpdate(notification),
      onPermission: (request, signal) => this.onPermission(request, signal),
      onReadTextFile: (request) => this.onReadTextFile(request),
      onWriteTextFile: (request) => this.onWriteTextFile(request),
      onElicitation: (request, signal) => this.onElicitation(request, signal),
      onXaiQuestion: (request, signal) => this.onXaiQuestion(request, signal),
      onXaiPlan: (request, signal) => this.onXaiPlan(request, signal),
      onXaiMcpElicit: (request, signal) => this.onXaiMcpElicit(request, signal),
      onXaiInteractionResolved: (toolCallId) => this.xaiInFlight.get(toolCallId)?.abort(),
    };
  }

  /** grok's three requests go through the two doors every agent's do, so parking, the log and the card are theirs (Q2.235). */
  private async onXaiQuestion(request: XaiQuestionRequest, signal: AbortSignal): Promise<XaiQuestionResponse> {
    // The text is the answer's key, so a question the card would draw cut is refused rather than asked in part.
    if (request.questions.some((one) => one.question.length > MAX_ELICITATION_MESSAGE_CHARS)) {
      throw acp.RequestError.invalidParams(
        {},
        `this client draws a question of at most ${MAX_ELICITATION_MESSAGE_CHARS} characters`,
      );
    }
    const answer = await this.withdrawable(request.toolCallId, signal, (live) =>
      this.onElicitation(questionElicitation(request), live),
    );
    return questionResponse(answer, request.questions);
  }

  private async onXaiPlan(request: XaiPlanRequest, signal: AbortSignal): Promise<XaiPlanResponse> {
    // grok's call carries no arguments, so the plan is written onto it: the snapshot's 8 KiB clamp would lose a long one.
    this.flushToolDraft();
    this.queue.push({
      type: "tool_call_update",
      toolCallId: boundToolCallId(request.toolCallId),
      title: null,
      status: null,
      locations: [],
      rawInput: { plan: request.plan },
      content: null,
      images: null,
      parentToolCallId: null,
      backgrounded: false,
    });
    const answer = await this.withdrawable(request.toolCallId, signal, (live) =>
      this.onPermission(planPermission(request), live),
    );
    return planResponse(answer);
  }

  private async onXaiMcpElicit(request: XaiMcpElicitRequest, signal: AbortSignal): Promise<XaiMcpElicitResponse> {
    const answer = await this.withdrawable(request.toolCallId, signal, (live) =>
      this.onElicitation(mcpElicitation(request), live),
    );
    return mcpElicitResponse(answer);
  }

  /** The SDK's signal and grok's own settling as one, so the registry's agent_withdrew path hears either. */
  private async withdrawable<T>(
    toolCallId: string | null,
    signal: AbortSignal,
    ask: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (toolCallId === null) return ask(signal);
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
    // Set on arrival and not before: the interaction_resolved closing grok's own permission step for this call comes just ahead of it.
    this.xaiInFlight.set(toolCallId, controller);
    try {
      return await ask(controller.signal);
    } finally {
      signal.removeEventListener("abort", forward);
      if (this.xaiInFlight.get(toolCallId) === controller) this.xaiInFlight.delete(toolCallId);
    }
  }

  private async onElicitation(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> {
    if (!this.elicitations) {
      throw acp.RequestError.invalidParams(
        {},
        "nobody is attached to this session who could answer a question",
      );
    }

    let form: ElicitationForm;
    try {
      form = toElicitationForm(request.requestedSchema);
    } catch (error) {
      if (error instanceof ElicitationRefusedError) {
        throw acp.RequestError.invalidParams({}, error.message);
      }
      throw error;
    }

    this.noteAgentWork();
    return this.elicitations(
      {
        toolCallId: request.toolCallId ?? null,
        message: clipElicitationMessage(request.message),
        form,
      },
      signal,
    );
  }

  // Holds streamed-argument drafts until they stop growing; may suppress less than tail.ts's supersedes, never more.
  private toolDraft: {
    toolCallId: string;
    // Null, not "": an empty base makes the first block look like an extension.
    block: string | null;
    status: acp.ToolCallStatus | null;
    held: Extract<SessionEvent, { type: "tool_call_update" }> | null;
  } | null = null;

  private flushToolDraft(): void {
    const draft = this.toolDraft;
    if (draft?.held == null) return;
    const event = draft.held;
    draft.held = null;
    this.queue.push(event);
  }

  private holdsToolDraft(event: Extract<SessionEvent, { type: "tool_call_update" }>): boolean {
    if (event.content?.length !== 1) return false;
    const block = event.content[0];
    if (block === undefined) return false;
    if (event.title !== null || event.rawInput !== null) return false;
    if (event.locations.length > 0 || event.images !== null) return false;
    const draft = this.toolDraft;
    if (draft === null || draft.block === null || draft.toolCallId !== event.toolCallId) return false;
    if (event.status !== draft.status) return false;
    if (block.length <= draft.block.length || !block.startsWith(draft.block)) return false;
    draft.block = block;
    draft.held = event;
    return true;
  }

  private onUpdate(notification: acp.SessionNotification): void {
    const update = notification.update;
    // Any other update ends the run, so the held block cannot land after a later event.
    if (update.sessionUpdate !== "tool_call_update") this.flushToolDraft();
    // Before the switch: these extension updates are not in the SDK's union.
    if (ASYNC_TASK_UPDATES.includes(update.sessionUpdate)) {
      const edge = readAsyncTaskEdge(update);
      if (edge !== null) this.applyAsyncTaskEdge(edge);
      return;
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk":
        if (update.sessionUpdate !== "user_message_chunk") this.noteAgentWork();
        this.queue.push({
          type: "text",
          role: update.sessionUpdate === "user_message_chunk" ? "user" : "agent",
          thought: update.sessionUpdate === "agent_thought_chunk",
          text: renderContentBlock(update.content),
          messageId: this.messageIdFor(update.messageId),
        });
        return;

      case "tool_call": {
        // toolCallLineage reads the raw id for its self-parent test.
        const toolCallId = boundToolCallId(update.toolCallId);
        const lineage = toolCallLineage(update);
        // A subagent's steps are a delegation the foot already counts, not the agent's own cycle.
        if (lineage.parentToolCallId === null) this.noteAgentWork();
        this.queue.push({
          type: "tool_call",
          toolCallId,
          title: update.title,
          kind: update.kind ?? "other",
          status: update.status ?? "pending",
          locations: toLocations(update.locations),
          rawInput: update.rawInput ?? null,
          ...lineage,
        });
        this.emitDiffs(toolCallId, update.content);
        return;
      }

      case "tool_call_update": {
        const images: StoredFileRef[] = [];
        // rawOutput only when the blocks carried nothing, or claude's output appears twice.
        const content =
          toolOutput(update.content, this.keepImage, images) ?? rawToolOutput(update.rawOutput);
        const toolCallId = boundToolCallId(update.toolCallId);
        const event: Extract<SessionEvent, { type: "tool_call_update" }> = {
          type: "tool_call_update",
          toolCallId,
          title: update.title ?? null,
          status: update.status ?? null,
          locations: toLocations(update.locations),
          rawInput: update.rawInput ?? null,
          content,
          images: images.length === 0 ? null : images,
          // Only the edge: claude drops `subagent` on a spawn's completing update.
          parentToolCallId: toolCallLineage(update).parentToolCallId,
          backgrounded: readBackgroundedMarker(update._meta),
        };
        if (event.parentToolCallId === null) this.noteAgentWork();
        // Raw one-block guard: a rendered single string may hide a diff block, which must not be held.
        if (update.content?.length === 1 && this.holdsToolDraft(event)) return;
        this.flushToolDraft();
        this.queue.push(event);
        this.toolDraft = {
          toolCallId: event.toolCallId,
          block: event.content?.length === 1 ? (event.content[0] ?? null) : null,
          status: event.status,
          held: null,
        };
        this.emitDiffs(toolCallId, update.content);
        return;
      }

      case "plan":
        this.noteAgentWork();
        this.queue.push({ type: "plan", entries: update.entries });
        return;

      case "current_mode_update":
        this.updateConfig({ currentModeId: update.currentModeId });
        return;

      case "config_option_update":
        this.updateConfig({ options: toConfigOptions(update.configOptions) });
        return;

      case "available_commands_update":
        this.updateCommands(toCommands(update.availableCommands));
        return;

      case "usage_update":
        this.updateUsage(update);
        // Any origin: one cycle runs at a time, so whichever just ended, the agent is between cycles.
        if (marksCycleEnd(update._meta)) {
          this.marksCycleEnds = true;
          this.setUnprompted(null);
        }
        return;

      default:
        this.queue.push({
          type: "other",
          sessionUpdate: update.sessionUpdate,
          raw: update,
        });
    }
  }

  private async onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    // Refused whole: optionIds round-trip verbatim, and dropping one removes a choice.
    const oversized =
      request.options.length > MAX_PERMISSION_OPTIONS ||
      request.options.some((option) => option.optionId.length > MAX_PERMISSION_OPTION_ID_CHARS);
    if (oversized) {
      throw acp.RequestError.invalidParams(
        `this client renders at most ${MAX_PERMISSION_OPTIONS} permission options, ` +
          `each with an optionId of at most ${MAX_PERMISSION_OPTION_ID_CHARS} characters`,
      );
    }

    const options: PermissionOptionSummary[] = request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const title = request.toolCall.title ?? request.toolCall.toolCallId;
    const weight = jsonBytes(title) + jsonBytes(options);
    if (weight > MAX_PERMISSION_SNAPSHOT_BYTES) {
      throw acp.RequestError.invalidParams(
        `a permission's title and options come to at most ${MAX_PERMISSION_SNAPSHOT_BYTES} bytes, ` +
          `and this one is ${weight}`,
      );
    }
    const choice =
      request.options.find((option) => option.kind === "allow_once") ??
      request.options.find((option) => option.kind === "allow_always") ??
      null;

    this.noteAgentWork();
    if (this.permissions && choice) {
      return this.permissions(
        {
          toolCallId: request.toolCall.toolCallId,
          title,
          options,
          rawInput: request.toolCall.rawInput ?? null,
          content: request.toolCall.content ?? null,
        },
        signal,
      );
    }

    this.queue.push({
      type: "permission_request",
      permissionId: null,
      toolCallId: request.toolCall.toolCallId,
      title,
      options,
      decision: choice?.optionId ?? null,
    });

    if (!choice) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: choice.optionId } };
  }

  private async onReadTextFile(
    request: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const path = request.path;

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw acp.RequestError.resourceNotFound(
        `${request.path}: ${describeError(error)}`,
      );
    }

    if (request.line == null && request.limit == null) return { content };

    const lines = content.split("\n");
    const start = Math.max((request.line ?? 1) - 1, 0);
    const end = request.limit == null ? lines.length : start + request.limit;
    return { content: lines.slice(start, end).join("\n") };
  }

  private async onWriteTextFile(
    request: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    const path = request.path;

    const oldText = await readFile(path, "utf8").catch(() => null);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, request.content, "utf8");

    this.queue.push({
      type: "file_change",
      path,
      oldText,
      newText: request.content,
      source: "fs_write",
      toolCallId: null,
    });
    return {};
  }

  // First update with diffs wins: claude reports each edit twice with different whitespace.
  private emitDiffs(
    toolCallId: string,
    content: acp.ToolCallContent[] | null | undefined,
  ): void {
    const diffs = (content ?? []).filter((item) => item.type === "diff");
    if (diffs.length === 0 || this.diffedToolCalls.has(toolCallId)) return;
    this.diffedToolCalls.add(toolCallId);

    for (const item of diffs) {
      this.queue.push({
        type: "file_change",
        path: item.path,
        oldText: item.oldText ?? null,
        newText: item.newText,
        source: "diff",
        toolCallId,
      });
    }
  }

  private waitForTurnToSettle(timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => !this.turnActive, timeoutMs);
  }

  private waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (done()) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }
}

const CLOSED: SessionEvent = Object.freeze({
  type: "error",
  message: "session closed",
  data: null,
});

/** By identity, never message: tells this daemon's teardown apart from an agent error. */
export function isSessionClosed(event: SessionEvent): boolean {
  return event === CLOSED;
}

// A claim wakes the previous reader with null; a turn is never displaced.
class EventQueue {
  private readonly buffered: SessionEvent[] = [];
  private waiting: ((event: SessionEvent | null) => void) | null = null;
  private closed = false;
  private reader = 0;
  private turnHolds = false;

  claimForTurn(): number {
    if (this.turnHolds) throw new Error("a turn already holds this session's events");
    this.turnHolds = true;
    return this.handover();
  }

  claimForIdle(): number | null {
    if (this.turnHolds) return null;
    return this.handover();
  }

  // Identity-checked: a stale release under a live turn pins ManagedSession.turn for ever.
  release(claim: number): void {
    if (claim !== this.reader) return;
    this.turnHolds = false;
  }

  private handover(): number {
    this.reader += 1;
    const displaced = this.waiting;
    this.waiting = null;
    displaced?.(null);
    return this.reader;
  }

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(event);
      return;
    }
    this.buffered.push(event);
    if (this.buffered.length <= MAX_BUFFERED_EVENTS) return;

    // Evict agent_log or other first, since a missing text leaves a transcript that reads as complete; with neither buffered, drop the oldest and say so.
    const droppable = this.buffered.findIndex(
      (candidate) => candidate.type === "agent_log" || candidate.type === "other",
    );
    if (droppable >= 0) {
      this.buffered.splice(droppable, 1);
      return;
    }
    this.buffered.shift();
    this.buffered.push({
      type: "error",
      message: "event dropped: session queue overflow",
      data: null,
    });
  }

  next(claim: number): Promise<SessionEvent | null> {
    if (claim !== this.reader) return Promise.resolve(null);
    const buffered = this.buffered.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(CLOSED);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.closed = true;
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.(CLOSED);
  }
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Also sends $/cancel_request; neither pinned adapter observes it on these extensions, so pendingResponses still fills.
function withAbandonableDeadline<T>(
  send: (options: acp.SendRequestOptions) => Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const abandon = new AbortController();
  const sent = send({ cancellationSignal: abandon.signal });
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandon.abort();
      reject(new Error(`${what} did not answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  return Promise.race([sent, expired]).finally(() => clearTimeout(timer));
}

function hasRpcCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/** Matched on the message: start and resume rewrap auth_required as a plain Error. */
export function isAuthRequiredMessage(message: string): boolean {
  return /authentication required/i.test(message);
}

function isAuthRequired(error: unknown): boolean {
  return hasRpcCode(error, AUTH_REQUIRED);
}

function toLocations(
  locations: acp.ToolCallLocation[] | null | undefined,
): FileLocation[] {
  return (locations ?? []).slice(0, MAX_TOOL_LOCATIONS).map((location) => ({
    path: clip(location.path, MAX_TOOL_LOCATION_CHARS),
    line: location.line ?? null,
  }));
}

// Clipped, not refused: the id identifies the call, and clip is deterministic.
function boundToolCallId(id: string): string {
  return clip(id, MAX_PARENT_ID_CHARS);
}

function sessionMetaOf(options: SessionOptions): Record<string, unknown> | undefined {
  return sessionMetaFor(options.agent, { ultracode: options.ultracode === true, elicitation: options.elicitations != null });
}

// Native pairings only. Answers a sentence: start refuses on it, openResumed demotes (Q2.216).
async function pinNativeModel(session: Session, options: SessionOptions): Promise<string | null> {
  const model = options.model ?? null;
  const system = options.system ?? null;
  if (model === null || model === "") return null;
  const machine = options.machine ?? BUILTIN_CATALOGUE;
  const spec = system === null ? null : machine.system(system);
  // A sentence, never a throw: openResumed must not strand a conversation (Q2.217).
  if (system !== null && spec === null) {
    return machine.systemState(system) === "disabled"
      ? `This session's provider comes from a plugin that is switched off on this machine.`
      : `This session's provider is no longer on this machine.`;
  }
  if (spec !== null && spec.nativeHarness !== options.agent) return null;

  // The one place a model id is respelled, so a preset stays harness-agnostic; idempotent.
  const prefix = spec?.nativeModelPrefix ?? null;
  const wanted = prefix === null || model.startsWith(prefix) ? model : `${prefix}${model}`;

  const option = session.modelOption;
  if (option === null) return `${options.agent} offers no choice of model on this machine.`;
  // Already on the model is done, even outside the published list (Q2.219).
  if (option.value === wanted) return null;
  if (!option.choices.some((one) => one.value === wanted)) {
    const names = option.choices.map((one) => one.value);
    const shown = names.slice(0, MODEL_NAMES_IN_PIN_REFUSAL).join(", ");
    const rest =
      names.length > MODEL_NAMES_IN_PIN_REFUSAL ? `, and ${names.length - MODEL_NAMES_IN_PIN_REFUSAL} more` : "";
    // The full stop is load-bearing: the resume notice appends a sentence.
    return (
      `${options.agent} has no model called ${JSON.stringify(wanted)}` +
      `${names.length === 0 ? "" : ` — it offers ${shown}${rest}`}.`
    );
  }
  await session.setConfigOption(option.id, wanted);
  return null;
}

const MODEL_NAMES_IN_PIN_REFUSAL = 8;

function spawnEnvOf(options: SessionOptions): NodeJS.ProcessEnv {
  const system = options.system ?? null;
  const model = options.model ?? null;
  if (system === null || model === null || model === "") return {};
  return routedModelEnv(options.agent, system, model, options.machine ?? BUILTIN_CATALOGUE);
}

// Between handshake and session/new: provider config is process-scoped. Returns whether it routed.
async function applySystem(
  client: AcpClient,
  options: SessionOptions,
  runtime: SessionRuntime,
): Promise<boolean> {
  const system = options.system ?? null;
  if (system === null) return false;
  const machine = options.machine ?? BUILTIN_CATALOGUE;
  const spec = machine.system(system);
  if (spec === null) {
    throw new SystemRoutingError(
      machine.systemState(system) === "disabled"
        ? `This session's provider comes from a plugin that is switched off on this machine.`
        : `This session's provider is no longer on this machine.`,
    );
  }
  // routedPairing may answer true where this throws, never false where this routes.
  if (spec.nativeHarness === options.agent) return false;

  const routing = await client.routing();
  const refusal = hostable(options.agent, system, routing, machine);
  if (refusal !== null) throw new SystemRoutingError(refusal);
  if (routing === null || spec.baseUrl === null) {
    throw new SystemRoutingError(`${spec.displayName} cannot be reached from this agent.`);
  }

  const secret = runtime.systemSecret(system);
  if (secret === null) {
    throw new SystemRoutingError(
      `No key is saved for ${spec.displayName} on this machine, so nothing can sign these requests.`,
    );
  }

  try {
    await withDeadline(
      client.setProvider({
        providerId: routing.providerId,
        apiType: spec.apiType,
        baseUrl: spec.baseUrl,
        headers: routingHeaders(system, secret, machine),
      }),
      SET_CONFIG_TIMEOUT_MS,
      "providers/set",
    );
  } catch (error) {
    throw new SystemRoutingError(
      `${client.config.displayName} refused to route to ${spec.displayName}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}

function metaParam(meta: Record<string, unknown> | undefined): { _meta?: Record<string, unknown> } {
  return meta === undefined ? {} : { _meta: meta };
}

// Ingest bounds on agent_config: round-tripping ids are dropped, prose clipped, MAX_CONFIG_BYTES the backstop.
const MAX_CONFIG_OPTIONS = 32;
const MAX_CONFIG_MODES = 32;
const MAX_CONFIG_CHOICES = 2048;
const MAX_CONFIG_ID_CHARS = 256;
const MAX_CONFIG_NAME_CHARS = 256;
const MAX_CONFIG_DESCRIPTION_CHARS = 512;
const MAX_CONFIG_BYTES = 256 * 1024;

function headChoices(option: AgentConfigOption, keep: number): AgentConfigOption {
  const head = option.choices.slice(0, keep);
  if (head.length > 0 && !head.some((choice) => choice.value === option.value)) {
    const selected = option.choices.find((choice) => choice.value === option.value);
    if (selected !== undefined) head[head.length - 1] = selected;
  }
  return { ...option, choices: head, truncated: true };
}

function fitConfigBytes(options: AgentConfigOption[]): AgentConfigOption[] {
  let out = options;
  while (jsonBytes(out) > MAX_CONFIG_BYTES) {
    let widest: AgentConfigOption | null = null;
    for (const option of out) {
      if (option.choices.length > 1 && (widest === null || option.choices.length > widest.choices.length)) {
        widest = option;
      }
    }
    if (widest === null) return out;
    const target = widest;
    out = out.map((option) => (option === target ? headChoices(option, option.choices.length >> 1) : option));
  }
  return out;
}

// An over-long currentModeId drops the whole state: a clipped id selects nothing.
function toModes(modes: acp.SessionModeState | null | undefined): AgentModes | null {
  if (modes == null) return null;
  if (modes.currentModeId.length > MAX_CONFIG_ID_CHARS) return null;
  return {
    current: modes.currentModeId,
    available: modes.availableModes
      .filter((mode) => mode.id.length <= MAX_CONFIG_ID_CHARS)
      .slice(0, MAX_CONFIG_MODES)
      .map((mode) => ({
        id: mode.id,
        name: clip(mode.name, MAX_CONFIG_NAME_CHARS),
        description: mode.description == null ? null : clip(mode.description, MAX_CONFIG_DESCRIPTION_CHARS),
      })),
  };
}

function toConfigOptions(options: acp.SessionConfigOption[] | null | undefined): AgentConfigOption[] {
  const bounded: AgentConfigOption[] = [];
  for (const option of options ?? []) {
    if (bounded.length >= MAX_CONFIG_OPTIONS) break;
    // Dropped, not clipped: both round-trip through sendConfigOption.
    if (option.id.length > MAX_CONFIG_ID_CHARS) continue;
    if (typeof option.currentValue === "string" && option.currentValue.length > MAX_CONFIG_ID_CHARS) continue;
    const all = option.type === "select" ? toChoices(option.options) : [];
    const kept = all.filter((choice) => choice.value.length <= MAX_CONFIG_ID_CHARS);
    const flat: AgentConfigOption = {
      id: option.id,
      name: clip(option.name, MAX_CONFIG_NAME_CHARS),
      description: option.description == null ? null : clip(option.description, MAX_CONFIG_DESCRIPTION_CHARS),
      category: option.category == null ? null : clip(option.category, MAX_CONFIG_NAME_CHARS),
      kind: option.type,
      value: option.currentValue,
      choices: kept,
    };
    // headChoices, not slice: the selected choice is often last and must survive.
    bounded.push(
      kept.length > MAX_CONFIG_CHOICES
        ? headChoices(flat, MAX_CONFIG_CHOICES)
        : kept.length === all.length
          ? flat
          : { ...flat, truncated: true },
    );
  }
  return fitConfigBytes(bounded);
}

// Clipped, not refused: this id never leaves the fleet.
const MAX_MESSAGE_ID_CHARS = 256;

/** Drops untypeable or duplicate names and counts them; clips prose. */
export function toCommands(list: acp.AvailableCommand[] | null | undefined): AgentCommands {
  const commands: AgentCommand[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of list ?? []) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (name.length === 0 || name.length > MAX_COMMAND_NAME_CHARS || seen.has(name)) {
      dropped += 1;
      continue;
    }
    if (commands.length >= MAX_AGENT_COMMANDS) {
      dropped += 1;
      continue;
    }
    seen.add(name);
    const hint = entry.input?.hint;
    commands.push({
      name,
      description: clip(typeof entry.description === "string" ? entry.description : "", MAX_COMMAND_DESCRIPTION_CHARS),
      hint: typeof hint === "string" && hint.length > 0 ? clip(hint, MAX_COMMAND_HINT_CHARS) : null,
    });
  }

  return { commands, dropped };
}

export class ElicitationRefusedError extends Error {}

export function clipElicitationMessage(message: string): string {
  if (typeof message !== "string") return "";
  return clip(message, MAX_ELICITATION_MESSAGE_CHARS);
}

/** Throws ElicitationRefusedError rather than drop a question; each type arm validates only what it reads. */
export function toElicitationForm(schema: acp.ElicitationSchema | null | undefined): ElicitationForm {
  const properties = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields: ElicitationField[] = [];

  for (const [key, property] of Object.entries(properties)) {
    if (fields.length >= MAX_ELICITATION_FIELDS) {
      throw new ElicitationRefusedError(
        `this client renders at most ${MAX_ELICITATION_FIELDS} form fields`,
      );
    }
    fields.push(toElicitationField(key, property, required.has(key)));
  }

  const keys = new Set(fields.map((field) => field.key));
  for (const field of fields) {
    if (field.alternativeTo === null) continue;
    if (field.alternativeTo === field.key || !keys.has(field.alternativeTo)) field.alternativeTo = null;
  }

  const form: ElicitationForm = { fields };
  if (jsonBytes(form) > MAX_ELICITATION_FORM_BYTES) {
    throw new ElicitationRefusedError(
      `this form is larger than the ${MAX_ELICITATION_FORM_BYTES} bytes this client will carry`,
    );
  }
  return form;
}

// Reads only the declared marker, never the key's suffix (Q6.54).
function customAnswerFor(property: acp.ElicitationPropertySchema): string | null {
  const meta = (property as Record<string, unknown>)["_meta"];
  if (meta === null || typeof meta !== "object") return null;
  const claims = meta as Record<string, unknown>;
  for (const [name, marker] of [
    ["_askUserQuestionCustomAnswer", "isCustomAnswer"],
    ["codex", "isOtherAnswer"],
  ] as const) {
    const claim = claims[name];
    if (claim === null || typeof claim !== "object") continue;
    const { questionId, ...rest } = claim as Record<string, unknown>;
    if (rest[marker] !== true || typeof questionId !== "string") continue;
    const key = questionId.trim();
    if (key !== "") return key;
  }
  return null;
}

function toElicitationField(
  key: string,
  property: acp.ElicitationPropertySchema,
  required: boolean,
): ElicitationField {
  const base = {
    key,
    title: textOrNull(property.title),
    description: textOrNull(property.description),
    required,
    alternativeTo: customAnswerFor(property),
  };

  const raw = property as Record<string, unknown>;

  switch (property.type) {
    case "string": {
      const format = raw["format"];
      return {
        ...base,
        kind: "string",
        // An empty projection is free text (null), or the validator refuses every answer.
        options: emptyToNull(toElicitationOptions(raw["oneOf"], raw["enum"])),
        min: numberOrNull(raw["minLength"]),
        max: numberOrNull(raw["maxLength"]),
        format: typeof format === "string" && FORMATS.has(format) ? (format as ElicitationField["format"]) : null,
        default: typeof raw["default"] === "string" ? (raw["default"] as string) : null,
      };
    }

    case "number":
    case "integer":
      return {
        ...base,
        kind: property.type,
        options: null,
        min: numberOrNull(raw["minimum"]),
        max: numberOrNull(raw["maximum"]),
        format: null,
        default: typeof raw["default"] === "number" ? (raw["default"] as number) : null,
      };

    case "boolean":
      return {
        ...base,
        kind: "boolean",
        options: null,
        min: null,
        max: null,
        format: null,
        default: typeof raw["default"] === "boolean" ? (raw["default"] as boolean) : null,
      };

    case "array": {
      const items = (raw["items"] ?? {}) as Record<string, unknown>;
      const options = toElicitationOptions(items["anyOf"], items["enum"]);
      if (options === null || options.length === 0) {
        throw new ElicitationRefusedError(
          `field ${JSON.stringify(key)} is a list with no choices, which this client cannot draw`,
        );
      }
      return {
        ...base,
        kind: "multi_select",
        options,
        min: numberOrNull(items["minItems"] ?? raw["minItems"]),
        max: numberOrNull(items["maxItems"] ?? raw["maxItems"]),
        format: null,
        default: Array.isArray(raw["default"])
          ? (raw["default"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
          : null,
      };
    }

    default:
      throw new ElicitationRefusedError(
        `field ${JSON.stringify(key)} has type ${JSON.stringify(property.type)}, which this client cannot draw`,
      );
  }
}

function emptyToNull(options: ElicitationOption[] | null): ElicitationOption[] | null {
  return options === null || options.length === 0 ? null : options;
}

function toElicitationOptions(titled: unknown, bare: unknown): ElicitationOption[] | null {
  const source: ElicitationOption[] = [];
  if (Array.isArray(titled)) {
    for (const raw of titled) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      if (typeof entry["const"] !== "string") continue;
      const value = entry["const"];
      const title = entry["title"];
      source.push({
        value,
        label: typeof title === "string" && title.length > 0 ? title : value,
        description: textOrNull(entry["description"]),
      });
    }
  } else if (Array.isArray(bare)) {
    for (const value of bare) {
      if (typeof value !== "string") continue;
      source.push({ value, label: value, description: null });
    }
  } else {
    return null;
  }

  const options: ElicitationOption[] = [];
  const seen = new Set<string>();
  for (const option of source) {
    if (option.value.length > MAX_ELICITATION_VALUE_CHARS) {
      throw new ElicitationRefusedError(
        `an option value is longer than the ${MAX_ELICITATION_VALUE_CHARS} characters this client will carry`,
      );
    }
    if (seen.has(option.value)) continue;
    if (options.length >= MAX_ELICITATION_OPTIONS) {
      throw new ElicitationRefusedError(
        `this client renders at most ${MAX_ELICITATION_OPTIONS} choices per field`,
      );
    }
    seen.add(option.value);
    options.push(option);
  }
  return options;
}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toChoices(options: acp.SessionConfigSelectOptions): AgentConfigChoice[] {
  const choices: AgentConfigChoice[] = [];
  for (const entry of options) {
    if ("group" in entry) {
      for (const option of entry.options) choices.push(toChoice(option, entry.name));
    } else {
      choices.push(toChoice(entry, null));
    }
  }
  return choices;
}

function toChoice(option: acp.SessionConfigSelectOption, group: string | null): AgentConfigChoice {
  return {
    value: option.value,
    name: clip(option.name, MAX_CONFIG_NAME_CHARS),
    description: option.description == null ? null : clip(option.description, MAX_CONFIG_DESCRIPTION_CHARS),
    group: group === null ? null : clip(group, MAX_CONFIG_NAME_CHARS),
  };
}

function renderContentBlock(
  block: acp.ContentBlock,
  keep?: (mime: string, data: string) => StoredFileRef | null,
  kept?: StoredFileRef[],
): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[resource_link ${block.uri}]`;
    case "resource":
      return `[resource ${block.resource.uri}]`;
    case "image": {
      const ref = keep?.(block.mimeType, block.data) ?? null;
      if (ref === null) return "[image]";
      kept?.push(ref);
      return "";
    }
    default:
      return `[${block.type}]`;
  }
}

function toolOutput(
  content: acp.ToolCallContent[] | null | undefined,
  keep?: (mime: string, data: string) => StoredFileRef | null,
  kept?: StoredFileRef[],
): string[] | null {
  if (!content || content.length === 0) return null;
  const blocks: string[] = [];
  let remaining = MAX_TOOL_OUTPUT_BYTES;
  let images = 0;
  for (const item of content) {
    if (item.type !== "content") continue;
    // Images need their own count: they spend no text budget.
    if (item.content.type === "image" && images >= MAX_IMAGES_PER_UPDATE) continue;
    const before = kept?.length ?? 0;
    const text = renderContentBlock(item.content, keep, kept);
    images += (kept?.length ?? 0) - before;
    if (text.length === 0) continue;
    if (remaining <= 0) {
      blocks.push(`…[truncated: tool output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`);
      break;
    }
    blocks.push(clip(text, remaining));
    remaining -= text.length;
  }
  return blocks.length > 0 ? blocks : null;
}

function rawToolOutput(rawOutput: unknown): string[] | null {
  if (rawOutput === null || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return null;
  const formatted = (rawOutput as Record<string, unknown>)["formatted_output"];
  if (typeof formatted !== "string") return null;
  const text = formatted.trim();
  if (text.length === 0) return null;
  return [clip(text, MAX_TOOL_OUTPUT_BYTES)];
}
