// Hand mirror of the daemon's wire types: importing src/ would pull node dependencies into the browser bundle.
// It can drift, so every narrowing fails open, and a field added after the first release is optional.

/** Closed on purpose: AGENT_LABEL and AgentGlyph's exhaustive switch need a fixed list. */
export const AGENT_IDS: readonly BuiltinAgentId[] = ["claude", "kimi", "codex", "opencode", "grok"];
export type BuiltinAgentId = "claude" | "kimi" | "codex" | "opencode" | "grok";

export type AgentId = string;

export function isBuiltinAgentId(value: string): value is BuiltinAgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"
  | (string & {});

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface FileLocation {
  path: string;
  line: number | null;
}

export interface PermissionOptionSummary {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface SessionStartedEvent {
  type: "session_started";
  agent: AgentId;
  sessionId: string;
  agentInfo: { name: string; version: string } | null;
  modes: AgentModes | null;
}

export interface AgentConfigChoice {
  value: string;
  name: string;
  description: string | null;
  group: string | null;
}

/** Render from category, never from id: ids differ between agents, and an unknown category still renders. */
export interface AgentConfigOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: "select" | "boolean";
  value: string | boolean;
  choices: AgentConfigChoice[];
  truncated?: boolean;
}

export interface AgentModes {
  current: string;
  available: { id: string; name: string; description: string | null }[];
}

export interface AgentConfig {
  modes: AgentModes | null;
  options: AgentConfigOption[];
}

export interface AgentConfigEvent extends AgentConfig {
  type: "agent_config";
}

export interface AgentCommand {
  name: string;
  description: string;
  hint: string | null;
}

export interface TextEvent {
  type: "text";
  role: "agent" | "user";
  thought: boolean;
  text: string;
  messageId?: string | null;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: FileLocation[];
  // May be the truncation stand-in when the event exceeded the per-event cap.
  rawInput: unknown;
  // A parent may be missing or arrive late, and cycles happen:
  // every walk needs a visited set, since MAX_DEPTH bounds the indent, not the graph.
  parentToolCallId?: string | null;
  // Read only from the tool_call: claude drops it on the completing update.
  subagent?: boolean;
}

export interface ToolCallUpdateEvent {
  type: "tool_call_update";
  toolCallId: string;
  title: string | null;
  status: ToolCallStatus | null;
  locations: FileLocation[];
  rawInput?: unknown;
  content?: string[] | null;
  images?: StoredFileRef[] | null;
  // Absent means this update did not say, never top level.
  parentToolCallId?: string | null;
  // False means nothing said so, never that nothing was backgrounded.
  backgrounded?: boolean;
}

export interface FileChangeEvent {
  type: "file_change";
  path: string;
  oldText: string | null;
  newText: string;
  source: "diff" | "fs_write";
  toolCallId: string | null;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  permissionId: string | null;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  decision: string | null;
}

export type AnswerResolvedBy =
  | "client"
  | "agent_withdrew"
  | "agent_gone"
  | "session_stopped"
  | "turn_ended"
  | "pump_failed"
  | "no_turn"
  | "turn_cancelled";

export interface PermissionResolvedEvent {
  type: "permission_resolved";
  permissionId: string;
  toolCallId: string | null;
  title: string;
  outcome: "selected" | "cancelled";
  optionId: string | null;
  by: AnswerResolvedBy;
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface PlanEvent {
  type: "plan";
  entries: PlanEntry[];
}

export interface StoredFileRef {
  uploadId: string;
  name: string;
  mime: string | null;
  bytes: number;
}

export interface PromptAttachmentRef extends StoredFileRef {
  inlined: boolean;
}

export interface PromptEvent {
  type: "prompt";
  text: string;
  attachments?: PromptAttachmentRef[];
}

export interface UploadAccepted {
  upload: {
    uploadId: string;
    name: string;
    originalName: string;
    mime: string | null;
    bytes: number;
    createdAt: number;
    sessionBytes: number;
    sessionLimit: number;
    sessionCount: number;
    countLimit: number;
  };
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENTS = 10;

export interface CredentialWritten {
  saved?: boolean;
  removed?: boolean;
  restarting?: number;
}

export interface ImportAccepted {
  import: {
    path: string;
    name: string;
    entries: number;
    bytes: number;
  };
}

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** The daemon applies this to every string field before the field's own maxLength. */
export const MAX_ANSWER_CHARS = 2048;

export interface StatusEvent {
  type: "status";
  status: SessionStatus;
  exit: SessionExit | null;
}

export type PlainReason = "not_requested" | "not_a_repo" | "unborn_head" | "git_missing";

export interface WorkspaceEvent {
  type: "workspace";
  mode: "worktree" | "plain";
  root: string;
  requestedCwd: string;
  branch: string | null;
  baseCommit: string | null;
  plainReason: PlainReason | null;
  warnings: { code: string; message: string }[];
}

export interface TurnEndEvent {
  type: "turn_end";
  stopReason: string;
  usage: unknown;
}

export interface ContextClearedEvent {
  type: "context_cleared";
  agentSessionId: string;
  previousAgentSessionId: string;
}

export interface AgentLogEvent {
  type: "agent_log";
  line: string;
}

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

export interface StoredEvent {
  readonly seq: number;
  readonly ts: number;
  readonly event: SessionEvent;
}

export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "blocked"
  | "stopping"
  | "exited"
  | "failed"
  | "interrupted"
  | "parked";

export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "exited",
  "failed",
  "interrupted",
  "parked",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** An agent process exists; stopping is excluded because a stopping frame may carry no controls. */
export const AGENT_LIVE_STATUSES: readonly SessionStatus[] = ["idle", "running", "blocked"];

export function hasLiveAgent(status: SessionStatus): boolean {
  return AGENT_LIVE_STATUSES.includes(status);
}

export interface MachineSettingsView {
  idleReleaseMinutes: number;
}

export type ExitReason =
  | "stopped"
  | "agent_exited"
  | "start_failed"
  | "start_timeout"
  | "daemon_shutdown"
  | "agent_kill_failed"
  | "daemon_restarted"
  | "config_changed"
  | "agent_signed_out"
  | "parked";

export const DAEMON_EXIT_REASONS: readonly ExitReason[] = [
  "daemon_restarted",
  "daemon_shutdown",
  "config_changed",
];

export const FINAL_EXIT_REASONS: readonly ExitReason[] = [
  "stopped",
  "agent_exited",
  "start_failed",
  "start_timeout",
  "agent_kill_failed",
  "agent_signed_out",
];

/** Asked as not final, so an unknown reason from a newer daemon reads as coming back, never as ended. */
export function endedWithDaemon(exit: { reason: ExitReason } | null | undefined): boolean {
  if (exit === null || exit === undefined) return false;
  return !FINAL_EXIT_REASONS.includes(exit.reason);
}

/** Absent means waiting, never failed. */
export interface SessionResumeState {
  state: "waiting" | "running" | "failed";
  attempts: number;
  error: { code: string; message: string } | null;
  at: number;
}

export type AgentHandle = { kind: "local"; pid: number };

export interface SessionExit {
  reason: ExitReason;
  detail: string | null;
  at: number;
  agentHandle: AgentHandle | null;
  agentConfirmedDead: boolean;
}

export interface SessionWorkspace {
  mode: "worktree" | "plain";
  root: string;
  requestedCwd: string;
  git: {
    repoRoot: string;
    commonDir: string;
    branch: string | null;
    createdBranch: boolean;
    baseCommit: string;
  } | null;
  plainReason: PlainReason | null;
  createdAt: number;
}

export interface PendingPermissionSnapshot {
  permissionId: string;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  raisedAt: number;
  rawInput: unknown;
  content: unknown;
}

export interface PendingElicitationSnapshot {
  elicitationId: string;
  toolCallId: string | null;
  message: string;
  fieldCount: number;
  raisedAt: number;
}

export interface ElicitationOption {
  value: string;
  label: string;
  description: string | null;
}

export interface ElicitationField {
  key: string;
  kind: "string" | "number" | "integer" | "boolean" | "multi_select";
  title: string | null;
  description: string | null;
  required: boolean;
  options: ElicitationOption[] | null;
  min: number | null;
  max: number | null;
  format: "email" | "uri" | "date" | "date-time" | null;
  default: string | number | boolean | string[] | null;
  alternativeTo?: string | null;
}

export interface ElicitationRequestEvent {
  type: "elicitation_request";
  elicitationId: string;
  toolCallId: string | null;
  message: string;
}

export interface ElicitationAnswerSummary {
  key: string;
  label: string;
  value: string;
}

export interface ElicitationResolvedEvent {
  type: "elicitation_resolved";
  elicitationId: string;
  toolCallId: string | null;
  message: string;
  action: "accept" | "decline" | "cancel";
  answers: ElicitationAnswerSummary[] | null;
  by: AnswerResolvedBy;
}

export interface QueuedPrompt {
  id: string;
  seq: number;
  at: number;
}

/** Mirrored, never re-derived: which states are terminal is the daemon's decision. */
export type AsyncTaskState = "running" | "paused" | "completed" | "failed" | "stopped";

export interface AsyncTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** outputFilePath is nulled on the session listing, so null there means not carried: read it from the socket or the single-session route. */
export interface BackgroundTask {
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
  endedAt: number | null;
}

export interface SnapshotReduction {
  pendingPermissions: number;
  pendingElicitations: number;
  blobs: boolean;
  // Client-only, written by store.unreduceSnapshot: the permission ids this client holds a whole record of.
  onRecord?: string[];
}

export interface SessionSnapshot {
  id: string;
  agent: AgentId;
  customAgent?: string | null;
  cwd: string;
  workspace: SessionWorkspace;
  status: SessionStatus;
  agentSessionId: string | null;
  agentHandle: AgentHandle | null;
  turn: number | null;
  turnStartedAt: number | null;
  cancelRequestedAt?: number | null;
  // Not always empty on a steerable agent: a failed steer falls back to this queue, so read it through queuedSeqs.
  queuedPrompts?: QueuedPrompt[];
  backgroundTasks?: BackgroundTask[];
  reportsBackgroundTasks?: boolean;
  midTurnDelivery?: "steer" | "queue" | null;
  lastEventAt: number | null;
  createdAt: number;
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  pendingPermissions: PendingPermissionSnapshot[];
  pendingElicitations?: PendingElicitationSnapshot[];
  // Absent means whole; set only on a socket frame the daemon cut, and its meaning narrows once store.ts merges it onto a row.
  reduced?: SnapshotReduction;
  exit: SessionExit | null;
  agentConfig?: AgentConfig;
  // Refetch on any change, never only on increase: a daemon restart resets it to 0.
  commandsRevision?: number;
  // size 0 means occupancy without a window: never divide by it or substitute a default.
  contextUsage?: { used: number; size: number; cost: { amount: number; currency: string } | null } | null;
  title?: string | null;
  pinned?: boolean;
  rank?: number | null;
  resume?: SessionResumeState;
}

export function isResumable(session: SessionSnapshot): boolean {
  return isTerminal(session.status) && session.agentSessionId !== null;
}

// For a terminal session exactly one of isParked, waitingForDaemon, resumeStalled and showsAsEnded is true.
// isParked is tested first, because endedWithDaemon reads an unknown reason as coming back.

export function isParked(session: SessionSnapshot): boolean {
  if (!isTerminal(session.status) || session.exit?.reason !== "parked") return false;
  return session.agentSessionId !== null;
}

export function parkedByOlderDaemon(session: SessionSnapshot): boolean {
  return isParked(session) && session.status !== "parked";
}

export function waitingForDaemon(session: SessionSnapshot): boolean {
  if (isParked(session)) return false;
  if (!isTerminal(session.status) || !endedWithDaemon(session.exit)) return false;
  return session.agentSessionId !== null && session.resume?.state !== "failed";
}

export function resumeStalled(session: SessionSnapshot): boolean {
  if (isParked(session)) return false;
  if (!isTerminal(session.status) || !endedWithDaemon(session.exit)) return false;
  return session.resume?.state === "failed" || session.agentSessionId === null;
}

export function showsAsEnded(session: SessionSnapshot): boolean {
  return (
    isTerminal(session.status) &&
    !isParked(session) &&
    !waitingForDaemon(session) &&
    !resumeStalled(session)
  );
}

export function showsWorking(session: SessionSnapshot): boolean {
  return session.turn !== null && !needsHuman(session) && !isTerminal(session.status);
}

/** Ignores turn on purpose and must not gate Send or Stop; stale pending calls are Tail.taskFloor's half. */
export function mayStillReport(session: SessionSnapshot): boolean {
  return !isTerminal(session.status) && session.status !== "stopping";
}

/** Wider than showsWorking by the blocked case; stopping is excluded because it lingers for seconds with a turn set. */
export function canCancelTurn(session: SessionSnapshot): boolean {
  return session.turn !== null && !isTerminal(session.status) && session.status !== "stopping";
}

/** The daemon refuses a restarting change while a turn is set, even with a permission parked (Q3.429). */
export function turnInFlight(session: SessionSnapshot): boolean {
  return session.turn !== null;
}

export function cancelInFlight(session: SessionSnapshot): boolean {
  return (session.cancelRequestedAt ?? null) !== null && canCancelTurn(session);
}

/** False for a daemon that does not send midTurnDelivery: it refuses mid-turn prompts. */
export function acceptsMidTurn(session: SessionSnapshot): boolean {
  const delivery = session.midTurnDelivery ?? null;
  return delivery === "steer" || delivery === "queue";
}

const NOTHING_WAITING: ReadonlySet<number> = new Set();

export function queuedSeqs(session: SessionSnapshot): ReadonlySet<number> {
  const waiting = session.queuedPrompts ?? [];
  return waiting.length === 0 ? NOTHING_WAITING : new Set(waiting.map((entry) => entry.seq));
}

const NO_BACKGROUND_TASKS: readonly BackgroundTask[] = [];

export function backgroundTasksOf(session: SessionSnapshot): readonly BackgroundTask[] {
  return session.backgroundTasks ?? NO_BACKGROUND_TASKS;
}

/** A hand copy of TERMINAL in src/acp/asynctasks.ts that nothing compares: change both together. */
export function taskFinished(state: AsyncTaskState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

export type HumanRequest =
  | { kind: "permission"; raisedAt: number; title: string; permission: PendingPermissionSnapshot }
  | { kind: "elicitation"; raisedAt: number; title: string; elicitation: PendingElicitationSnapshot };

export function humanRequests(session: SessionSnapshot): HumanRequest[] {
  const requests: HumanRequest[] = [];
  for (const permission of session.pendingPermissions) {
    requests.push({
      kind: "permission",
      raisedAt: permission.raisedAt,
      title: permission.title,
      permission,
    });
  }
  for (const elicitation of session.pendingElicitations ?? []) {
    requests.push({
      kind: "elicitation",
      raisedAt: elicitation.raisedAt,
      title: elicitation.message,
      elicitation,
    });
  }
  return requests.sort((a, b) => a.raisedAt - b.raisedAt);
}

export function needsHuman(session: SessionSnapshot): boolean {
  return waitingCount(session) > 0;
}

/** Counted off reduced where set, since a cut frame's arrays are only a prefix; never fewer than humanRequests. */
export function waitingCount(session: SessionSnapshot): number {
  const permissions = Math.max(session.pendingPermissions.length, session.reduced?.pendingPermissions ?? 0);
  const questions = Math.max(session.pendingElicitations?.length ?? 0, session.reduced?.pendingElicitations ?? 0);
  return permissions + questions;
}

export function oldestWait(session: SessionSnapshot): number {
  let oldest = Infinity;
  for (const permission of session.pendingPermissions) {
    if (permission.raisedAt < oldest) oldest = permission.raisedAt;
  }
  for (const elicitation of session.pendingElicitations ?? []) {
    if (elicitation.raisedAt < oldest) oldest = elicitation.raisedAt;
  }
  return oldest;
}

export function countsAsLive(session: SessionSnapshot): boolean {
  return !isTerminal(session.status) || waitingForDaemon(session);
}

export interface HelloFrame {
  type: "hello";
  instanceId: string;
  session: SessionSnapshot;
  firstSeq: number;
  lastSeq: number;
  since: number;
  gap: boolean;
}

export interface EventsFrame {
  type: "events";
  events: StoredEvent[];
}

export interface SnapshotFrame {
  type: "snapshot";
  session: SessionSnapshot;
}

export interface CaughtUpFrame {
  type: "caught_up";
  seq: number;
}

/** Inclusive: advance the cursor to the upper bound. A backlog reason is not a loss: page it, never draw a hole. */
export interface LaggedFrame {
  type: "lagged";
  from: number;
  to: number;
  dropped: number;
  reason: "evicted" | "slow_consumer" | "backlog";
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
}

export type StreamFrame = HelloFrame | EventsFrame | SnapshotFrame | CaughtUpFrame | LaggedFrame | ErrorFrame;

export interface DaemonHealth {
  ok: boolean;
  instanceId: string;
  startedAt: number;
  uptimeMs: number;
  shuttingDown: boolean;
  time: number;
  authMode: "shared_secret" | "signed" | "both";
  // A label, never a gate: nothing may branch on the daemon version.
  version?: string;
  protocol?: number;
}

/** Named as the daemon names it, not AgentInfo: the drift check matches mirrors by name, so every interface here must use the daemon's own name. */
export interface AgentAvailability {
  id: AgentId;
  displayName: string;
  settingsMode?: ClaudeSettingsMode | null;
  available: boolean;
  hint: string | null;
  // null means could not tell, which must never draw as logged out.
  loggedIn?: boolean | null;
  lastStartRefusal?: { at: number; routed: boolean; message: string } | null;
  login?: AgentLoginSupport;
  // Absent means false: an older daemon has no install routes. Narrower than not available.
  installable?: boolean;
  label?: string;
  contributedBy?: { pluginId: string; pluginName: string };
}

export interface ClaudeSettingsMode {
  value: string;
  file: string;
}

export interface AgentCredentialSlot {
  envName: string;
  set: boolean;
  updatedAt: number | null;
}

export interface AgentLoginSupport {
  supported: boolean;
  // A narrowing, never a gate: supported decides whether the button is drawn.
  blocked?: "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null;
  needsInput: boolean;
  canSignOut?: boolean;
}

export interface AgentAuthInfo extends AgentAvailability {
  credentials: AgentCredentialSlot[];
}

export interface AgentAuthListing {
  os?: string;
  loginSupported: boolean;
  agents: AgentAuthInfo[];
}

export interface SystemInfo {
  id: string;
  displayName: string;
  apiType: string;
  routable?: boolean;
  nativeHarness: AgentId | null;
  loginVia: AgentId | null;
  models: { id: string; name: string }[];
  nativeModelPrefix?: string | null;
  keyEnv?: string | null;
  keySet: boolean;
  keyUpdatedAt: number | null;
  contributedBy?: { pluginId: string; pluginName: string };
}

/** providerId is the agent's own and changes between versions, so never hard-code one. */
export interface AgentRouting {
  providerId: string;
  supported: string[];
  // Absent means true, the opposite of routable: an older daemon can only route the built-in that always could.
  pinsModel?: boolean;
}

export interface AgentCapabilities {
  models: { id: string; name: string; description: string | null; group: string | null }[];
  routing: AgentRouting | null;
  cli?: { version: string | null; source: "override" | "path" } | null;
  error: string | null;
}

export interface CustomAgent {
  id: string;
  name: string;
  harness: AgentId;
  system: string;
  model: string;
  createdAt: number;
}

export interface AgentStripEntry {
  kind: "harness" | "custom";
  ref: string;
  hidden: boolean;
}

export interface LoginRunView {
  loginId: string;
  agent: AgentId;
  startedAt: number;
  done: boolean;
  exit: { code: number | null; signal: string | null } | null;
  dropped: number;
  cursor: number;
}

export interface LoginChunk extends LoginRunView {
  chunk: string;
  gap: boolean;
}

export type InstallOutcome =
  | "running"
  | "installed"
  | "failed"
  | "locked"
  | "timeout"
  | "cancelled"
  | "spawn_failed";

export type InstallPhase = "start" | "download" | "install" | "link" | "done" | "failed";

export interface InstallRunView {
  installId: string;
  agent: AgentId;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  // Never derived from exit: the installer exits 0 on failure, so the daemon decides.
  outcome: InstallOutcome;
  exit: { code: number | null; signal: string | null } | null;
  phase: InstallPhase | null;
  detail: string | null;
  dropped: number;
  cursor: number;
  cancellable?: boolean;
}

export interface InstallChunk extends InstallRunView {
  chunk: string;
  gap: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  entries: number | null;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

export interface RootListing {
  roots: string[];
  recent: string[];
}

export interface EventsPage {
  events: StoredEvent[];
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  gap: boolean;
}

/** A row missing past the limit may still exist: never prune local state on it while truncated. */
export interface SessionList {
  sessions: SessionSnapshot[];
  now: number;
  instanceId: string;
  total?: number;
  truncated?: boolean;
}

export interface WireError {
  error: { code: string; message: string; detail: unknown };
}

export type Scope = "session:read" | "session:write" | "machine:admin";

export function lastSeenText(at: number | null | undefined, now = Date.now()): string | null {
  if (at === undefined || at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) return null;
  if (seconds < 5400) return `last seen ${Math.round(seconds / 60)} min ago`;
  if (seconds < 129_600) return `last seen ${Math.round(seconds / 3600)} h ago`;
  return `last seen ${Math.round(seconds / 86_400)} days ago`;
}

export function enrolledByText(who: string | null | undefined): string | null {
  if (who === undefined || who === null || who.length === 0) return null;
  return `Enrolled by ${who}`;
}

export function ambiguousNames(machines: readonly { name: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const machine of machines) {
    const folded = machine.name.toLowerCase();
    if (seen.has(folded)) twice.add(folded);
    else seen.add(folded);
  }
  return twice;
}

export interface MachineRecord {
  id: string;
  name: string;
  enrolled: boolean;
  // null means never seen; absent means an older control plane that cannot say.
  lastSeenAt?: number | null;
  owned?: boolean;
  // Named so the natural true test degrades an older control plane to nothing suspended.
  overLimit?: boolean;
  ownerDisabled?: boolean;
  // Whose code enrolled it, when not the reader: the visible half of a substitution that cannot be refused.
  // Names who minted the code, never who redeemed it.
  enrolledBy?: string | null;
  scopes: Scope[];
  relayUrl: string | null;
  relayOnline: boolean;
}

export interface IssuedToken {
  token: string;
  // Epoch milliseconds, already converted from the exp claim's seconds.
  expiresAt: number;
  scopes: Scope[];
  machine: {
    id: string;
    name: string;
    relayUrl: string | null;
    relayOnline: boolean;
    // null for a machine that has not announced a key; the client refuses the route without one.
    key?: string | null;
  };
  // The lifetime is expiresAt minus serverTime; never compare expiresAt with the local clock.
  serverTime?: number;
}

export interface Me {
  id: string;
  name: string;
  isAdmin: boolean;
  via?: "api_key" | "session";
  hasPassword?: boolean;
  passwordChangedAt?: number | null;
  email?: string | null;
  emailVerified?: boolean;
  // Only an explicit true counts: failing closed would trap somebody in a password form during an outage.
  mustChangePassword?: boolean;
  mustChangePasswordReason?: string | null;
  // canAddMachine is the control plane's answer, never recomputed; machineCount counts owned machines only.
  machineCount?: number;
  machineLimit?: number | null;
  canAddMachine?: boolean;
}

export interface SessionToken {
  token: string;
  sessionId: string;
  expiresAt: number;
  user: Me;
  serverTime?: number;
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  current: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  // Whether a key exists, never the key; undefined means nobody said, which is not false.
  hasKey?: boolean;
  keySetAt?: number | null;
  current: boolean;
}

export interface EnrollmentCode {
  code: string;
  machineId?: string;
  expiresAt: number;
  controlPlaneUrl: string;
}

export interface CreatedMachine {
  machine: MachineRecord;
  enrollment: { code: string; expiresAt: number };
  controlPlaneUrl: string;
}

export interface AdminUser {
  id: string;
  name: string;
  isAdmin: boolean;
  createdAt: number;
  disabled: boolean;
  hasPassword: boolean;
  sessions: number;
  email?: string | null;
  emailVerified?: boolean;
  mustChangePassword?: boolean;
}

export interface CreatedUser {
  id: string;
  name: string;
  isAdmin: boolean;
  invited: boolean;
  password?: string;
  email?: string;
  mailQueued?: boolean;
  mustChangePassword?: boolean;
}

export type PluginScope =
  | "sessions.read"
  | "sessions.write"
  | "files.read"
  | "store"
  | "net"
  | "model"
  | "harness"
  | "system";

/** Written by this client, never fetched; exhaustive here, but callers still fall back to the raw scope for a newer daemon. */
export const PLUGIN_SCOPE_TEXT: Record<PluginScope, string> = {
  "sessions.read": "read your sessions and transcripts",
  "sessions.write": "control sessions, and answer agents' questions",
  "files.read": "read files in a session's workspace",
  store: "keep its own data here",
  net: "reach the hosts it lists",
  model: "ask your agents, at your cost",
  harness: "add an agent that runs a program it names",
  system: "add a provider your saved keys are sent to",
};

export const PLUGIN_SCOPE_TEXT_MAX = 56;

export type PluginHook =
  | "session.created"
  | "turn.ended"
  | "session.ended"
  | "permission.requested"
  | "permission.resolved";

export interface PluginAction {
  id: string;
  title: string;
  on: "session" | "screen";
}

export interface HarnessContribution {
  id: string;
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  routedModelEnv: string[];
  authHint: string | null;
}

export interface SystemContribution {
  id: string;
  name: string;
  apiType: string;
  baseUrl: string | null;
  authHeader: { name: string; prefix: string } | null;
  models: { id: string; name: string }[];
  nativeHarness: string | null;
  loginVia: string | null;
  nativeModelPrefix: string | null;
  keyEnv: string | null;
}

export interface PluginContributions {
  screen: { title: string } | null;
  settings: boolean;
  actions: PluginAction[];
  hooks: PluginHook[];
  harnesses?: HarnessContribution[];
  systems?: SystemContribution[];
}

export type PluginState = "running" | "stopped" | "failed" | "starting";

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string | null;
  scopes: PluginScope[];
  net: string[];
  contributes: PluginContributions;
  enabled: boolean;
  state: PluginState;
  failure: string | null;
  installedAt: number;
  updatedAt: number;
}

export interface PluginListing {
  plugins: PluginSummary[];
  api: number;
}

export interface PluginRowAction {
  id: string;
  label: string;
  tone: "plain" | "destructive";
  confirm: string | null;
}

export type PluginRowTone = "ok" | "warn" | "danger";

/** A destination this app has, never a URL. */
export type PluginOpen = { session: string } | { screen: true };

export interface PluginRow {
  id: string;
  title: string;
  subtitle: string | null;
  badge: string | null;
  tone: PluginRowTone | null;
  open: PluginOpen | null;
  actions: PluginRowAction[];
}

export type PluginFieldKind = "text" | "password" | "number" | "toggle" | "select";

export type PluginSurface = "screen" | "settings";

export const PLUGIN_SETTINGS_BLOCK_TYPES: readonly PluginBlock["type"][] = ["text", "notice", "form"];

export const PLUGIN_SETTINGS_FIELD_KINDS: readonly PluginFieldKind[] = ["text", "toggle", "select"];

export interface PluginFieldOption {
  value: string;
  label: string;
}

export interface PluginField {
  key: string;
  label: string;
  kind: PluginFieldKind;
  value: string | null;
  options: PluginFieldOption[];
  placeholder: string | null;
  help: string | null;
}

export type PluginBlock =
  | { type: "text"; text: string; tone: "default" | "muted" }
  | { type: "notice"; text: string; tone: "default" | "danger" }
  | { type: "list"; rows: PluginRow[]; empty: string }
  | { type: "columns"; columns: { title: string; rows: PluginRow[] }[] }
  | { type: "form"; fields: PluginField[]; submit: string; action: string };

export interface PluginView {
  title: string | null;
  refreshMs: number | null;
  blocks: PluginBlock[];
}

export type PluginResult =
  | { kind: "view"; view: PluginView }
  | { kind: "toast"; text: string; tone: "default" | "danger" };

export interface PluginInstalled {
  plugin: PluginSummary;
  replaced: string | null;
}
