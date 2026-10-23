import { ApiError } from "./http";
import type { CredentialWritten } from "./wire";
import type { ContentValue } from "./elicitation";
import type { SessionId } from "./ids";
import type { MachineConnection } from "./machine";
import type {
  DevicesAnswer,
  MachineSettingsView,
  AgentAuthListing,
  AgentCapabilities,
  AgentCommand,
  AgentConfig,
  AgentId,
  AgentAvailability,
  AgentStripEntry,
  CustomAgent,
  SystemInfo,
  DirListing,
  ElicitationField,
  EventsPage,
  InstallChunk,
  InstallRunView,
  LoginChunk,
  LoginRunView,
  MachineLinkGrant,
  MentionListing,
  PeerMessagingState,
  PermissionOptionSummary,
  RootListing,
  SessionList,
  SessionSnapshot,
  BoardDocument,
  BoardWritten,
  TaskAssignee,
  TaskCommentView,
  TaskFeed,
  TaskList,
  TaskSnapshot,
  TaskStatus,
  ImportAccepted,
  PluginInstalled,
  PluginListing,
  PluginResult,
  PluginSummary,
  UploadAccepted,
} from "./wire";

/** Bound to one machine, so a session id can never reach the wrong daemon. */
/** What `PATCH /tasks/:id` takes; an agent or a folder alone keeps the other. */
export interface TaskChangeBody {
  title?: string;
  brief?: string;
  summary?: string;
  status?: Exclude<TaskStatus, "needs_you">;
  agent?: string;
  customAgent?: string | null;
  /** Nobody or its person; naming an agent assigns it (Q2.261, Q2.262). */
  assignee?: TaskAssignee;
  cwd?: string;
  /** Files staged by `uploadTaskFile`, added to the task's own; an older daemon drops them without a word (Q2.277). */
  attachments?: string[];
  /** Its place among its column's cards (Q2.278). */
  rank?: number | null;
}

export class DaemonClient {
  constructor(private readonly machine: MachineConnection) {}

  agents(): Promise<{ agents: AgentAvailability[] }> {
    return this.machine.request<{ agents: AgentAvailability[] }>("/agents");
  }

  // systems and customAgents are cheap table reads; agentCapabilities starts an agent per harness.

  systems(): Promise<{ systems: SystemInfo[] }> {
    return this.machine.request<{ systems: SystemInfo[] }>("/systems");
  }

  saveSystemKey(system: string, token: string): Promise<{ saved: true; system: string }> {
    return this.machine.request(`/systems/${encodeURIComponent(system)}`, {
      method: "PUT",
      body: JSON.stringify({ token }),
    });
  }

  /** removed is false for a key this build cannot resolve, or on a replayed delete. */
  removeSystemKey(system: string): Promise<{ removed: boolean; system: string }> {
    return this.machine.request(`/systems/${encodeURIComponent(system)}`, { method: "DELETE" });
  }

  agentCapabilities(): Promise<{ agents: Record<string, AgentCapabilities> }> {
    return this.machine.request<{ agents: Record<string, AgentCapabilities> }>(
      "/agents/capabilities",
    );
  }

  customAgents(): Promise<{ customAgents: CustomAgent[] }> {
    return this.machine.request<{ customAgents: CustomAgent[] }>("/custom-agents");
  }

  /** On slowRoute's budget: the daemon starts the harness to validate the pairing before it answers. */
  addCustomAgent(
    body: {
      name: string;
      harness: AgentId;
      system: string;
      model: string;
    },
    signal?: AbortSignal,
  ): Promise<{ customAgent: CustomAgent }> {
    return this.machine.request<{ customAgent: CustomAgent }>("/custom-agents", {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  updateCustomAgent(
    id: string,
    body: {
      name: string;
      harness: AgentId;
      system: string;
      model: string;
    },
    signal?: AbortSignal,
  ): Promise<{ customAgent: CustomAgent }> {
    return this.machine.request<{ customAgent: CustomAgent }>(
      `/custom-agents/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }

  /** removed is false on a replayed delete whose first answer was lost. */
  removeCustomAgent(id: string): Promise<{ removed: boolean; id: string }> {
    return this.machine.request(`/custom-agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** An older daemon answers the bare 404 `meansRouteAbsent` reads. */
  devices(): Promise<DevicesAnswer> {
    return this.machine.request("/devices");
  }

  /** `device` is this installation's own key and name, so whoever turns the lock on is let in beside it. */
  setDeviceLock(on: boolean, device: { publicKey: string; name: string; platform: string } | null): Promise<DevicesAnswer> {
    return this.machine.request("/devices/lock", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(on && device !== null ? { on, device } : { on }),
    });
  }

  approveDevice(id: string): Promise<DevicesAnswer & { approved: true; id: string }> {
    return this.machine.request(`/devices/${encodeURIComponent(id)}/approve`, { method: "POST" });
  }

  /** removed is false on a replayed delete whose first answer was lost. */
  removeDevice(id: string): Promise<DevicesAnswer & { removed: boolean; id: string }> {
    return this.machine.request(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  machineSettings(): Promise<{ settings: MachineSettingsView }> {
    return this.machine.request("/settings");
  }

  /** One key at a time, so an older client cannot erase settings it does not know. */
  saveMachineSettings(patch: Partial<Record<keyof MachineSettingsView, number>>): Promise<{
    saved: true;
    settings: MachineSettingsView;
  }> {
    return this.machine.request("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  /**
   * Replaces the whole set the daemon holds; an older daemon answers the bare 404 `meansRouteAbsent` reads.
   * `policy` is the control plane's own answer or null, never made up here: an absent one leaves the daemon's alone (Q1.654).
   */
  putPeerLinks(
    links: readonly MachineLinkGrant[],
    policy: { messaging: boolean; isolated?: boolean; policyAt?: number } | null = null,
    /** What its owner calls this machine, which a board's `on` names it by; an older daemon ignores it (Q2.274). */
    name: string | null = null,
  ): Promise<{
    links: { id: string; target: { id: string; name: string }; expiresAt: number }[];
    messaging?: PeerMessagingState;
  }> {
    const body = { links, ...(policy ?? {}), ...(name === null ? {} : { self: { name } }) };
    return this.machine.request("/peers/links", { method: "PUT", body: JSON.stringify(body) });
  }

  agentStrip(): Promise<{ entries: AgentStripEntry[] }> {
    return this.machine.request<{ entries: AgentStripEntry[] }>("/agent-strip");
  }

  saveAgentStrip(
    entries: readonly AgentStripEntry[],
  ): Promise<{ saved: true; entries: AgentStripEntry[] }> {
    return this.machine.request("/agent-strip", {
      method: "PUT",
      body: JSON.stringify({ entries }),
    });
  }

  agentAuth(): Promise<AgentAuthListing> {
    return this.machine.request<AgentAuthListing>("/agent-auth");
  }

  saveCredential(agent: string, envName: string, token: string): Promise<CredentialWritten> {
    return this.machine.request(`/agent-auth/${encodeURIComponent(agent)}`, {
      method: "PUT",
      body: JSON.stringify({ envName, token }),
    });
  }

  clearCredential(agent: string, envName: string): Promise<CredentialWritten> {
    const query = new URLSearchParams({ envName });
    return this.machine.request(`/agent-auth/${encodeURIComponent(agent)}?${query.toString()}`, {
      method: "DELETE",
    });
  }

  startLogin(agent: string): Promise<LoginRunView> {
    return this.machine.request<LoginRunView>(`/agent-auth/${encodeURIComponent(agent)}/login`, {
      method: "POST",
    });
  }

  /** `since` is a byte cursor into the whole transcript, not a line count. */
  readLogin(loginId: string, since: number): Promise<LoginChunk> {
    const query = new URLSearchParams({ since: String(since) });
    return this.machine.request<LoginChunk>(
      `/agent-auth/login/${encodeURIComponent(loginId)}?${query.toString()}`,
    );
  }

  /** HTTP rather than the stream: a login code must not vanish into a half-open socket. */
  writeLogin(loginId: string, text: string): Promise<LoginRunView> {
    return this.machine.request<LoginRunView>(
      `/agent-auth/login/${encodeURIComponent(loginId)}/input`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
  }

  /** Also clears the pasted credential, or the login probe would still report signed in. */
  signOut(agent: string): Promise<{ signedOut: boolean; credentialsCleared: number }> {
    return this.machine.request(`/agent-auth/${encodeURIComponent(agent)}/logout`, {
      method: "POST",
    });
  }

  recheckAgent(agent: string): Promise<{ agent: string; rechecked: boolean; info?: AgentAvailability }> {
    return this.machine.request(`/agent-auth/${encodeURIComponent(agent)}/recheck`, {
      method: "POST",
    });
  }

  cancelLogin(loginId: string): Promise<{ cancelled: boolean }> {
    return this.machine.request(`/agent-auth/login/${encodeURIComponent(loginId)}`, {
      method: "DELETE",
    });
  }

  /** Not a slow route: the POST answers with a run id at once, and a resend would be a second install. */
  startInstall(agent: string): Promise<InstallRunView> {
    return this.machine.request<InstallRunView>(`/agent-install/${encodeURIComponent(agent)}`, {
      method: "POST",
    });
  }

  /** `since` is a byte cursor into the whole transcript, not a line count. */
  readInstall(installId: string, since: number): Promise<InstallChunk> {
    const query = new URLSearchParams({ since: String(since) });
    return this.machine.request<InstallChunk>(
      `/agent-install/runs/${encodeURIComponent(installId)}?${query.toString()}`,
    );
  }

  cancelInstall(installId: string): Promise<{ cancelled: boolean }> {
    return this.machine.request(`/agent-install/runs/${encodeURIComponent(installId)}`, {
      method: "DELETE",
    });
  }

  /** A rejection is not an answer: never read it as there being no run. */
  liveInstall(): Promise<{ supported: boolean; run: InstallRunView | null }> {
    return this.machine.request("/agent-install");
  }

  roots(): Promise<RootListing> {
    return this.machine.request<RootListing>("/fs/roots");
  }

  listDir(path: string | null, showHidden = false): Promise<DirListing> {
    const query = new URLSearchParams();
    if (path !== null) query.set("path", path);
    if (showHidden) query.set("hidden", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.machine.request<DirListing>(`/fs/list${suffix}`);
  }

  /** Parent and name separately: the daemon validates name as a single segment. */
  makeDir(parent: string, name: string): Promise<{ path: string }> {
    return this.machine.request<{ path: string }>("/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    });
  }

  /** truncated tells a session outside the window from one that is gone; now is the daemon's clock, not the browser's. */
  listSessions(limit?: number): Promise<SessionList> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    return this.machine.request<SessionList>(`/sessions${query}`);
  }

  createSession(body: {
    // Ignored when customAgent is given: the daemon fills it from the preset.
    agent: string;
    customAgent?: string | null;
    cwd: string;
    worktree?: boolean | "auto" | "require" | "never";
    branch?: string;
    // 409 `nickname_taken`, 400 `invalid_nickname`; an older daemon ignores it and answers a snapshot without one.
    nickname?: string;
  }): Promise<{ session: SessionSnapshot }> {
    return this.machine.request<{ session: SessionSnapshot }>("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** An older daemon has no such route and answers the bare 404 `meansRouteAbsent` reads (Q2.258). */
  listTasks(): Promise<TaskList> {
    return this.machine.request<TaskList>("/tasks");
  }

  /** `key` makes a create that is sent twice one task; with `start` the daemon launches the agent and hands it the brief. */
  createTask(body: {
    title?: string;
    brief: string;
    agent: string;
    customAgent?: string | null;
    /** Nobody or its person; the agent named is still what a start would launch. */
    assignee?: TaskAssignee;
    /** The column a person made it in; never beside `start`. */
    status?: "ready" | "review" | "done";
    /** A column of the board, on a daemon that runs one; never beside `start` or `status`. Into a work column its run starts. */
    column?: string;
    labels?: string[];
    cwd: string;
    key: string;
    start: boolean;
    /** Files staged by `uploadTaskFile`, which the first message of every new conversation on it carries (Q2.273). */
    attachments?: string[];
  }): Promise<{ task: TaskSnapshot; session?: SessionSnapshot; sent?: boolean; existing?: boolean }> {
    return this.machine.request("/tasks", { method: "POST", body: JSON.stringify(body) });
  }

  /** A file for a task or a comment not sent yet, staged on this machine until the create or comment names it. */
  uploadTaskFile(
    file: File,
    name: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<{ upload: { uploadId: string; name: string; mime: string | null; bytes: number } }> {
    return this.machine.upload(`/tasks/uploads?name=${encodeURIComponent(name)}`, file, onProgress, signal);
  }

  downloadTaskFile(id: string, fileId: string): Promise<Blob> {
    return this.machine.download(`/tasks/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`);
  }

  /**
   * A person's move, by column or by exit, from the column they saw it in: `409 task_moved` when it is no longer there,
   * `409 task_working` while its agent works and the column is not final, which `stop` answers by stopping the turn first.
   */
  moveTask(
    id: string,
    body: ({ to: string } | { exit: string }) & { from?: string | null; stop?: boolean },
  ): Promise<{ task: TaskSnapshot }> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify(body) });
  }

  /** The feed and the history; an older daemon answers the bare 404 `meansRouteAbsent` reads. */
  taskFeed(id: string): Promise<TaskFeed> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}/comments`);
  }

  /** Into the run's conversation while one works, else into the next run's note. */
  addTaskComment(id: string, text: string, attachments: readonly string[] = []): Promise<{ comment: TaskCommentView }> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      // Omit the key when empty, so an older daemon sees the body it always saw.
      body: JSON.stringify(attachments.length === 0 ? { text } : { text, attachments }),
    });
  }

  /** The account's board as this daemon holds it; an older daemon answers the bare 404 `meansRouteAbsent` reads. */
  board(): Promise<BoardDocument> {
    return this.machine.request("/board");
  }

  /**
   * The YAML whole, written against the revision this daemon was read at: `409 board_revision` carries the one it holds now,
   * `400 board_invalid` every refusal.
   */
  putBoard(text: string, revision: number): Promise<BoardWritten> {
    return this.machine.request("/board", {
      method: "PUT",
      headers: { "if-match": String(revision) },
      body: new Blob([text], { type: "text/yaml" }),
    });
  }

  /** This machine's config agent, or null; an older daemon answers the bare 404 `meansRouteAbsent` reads (Q2.270). */
  boardAgent(): Promise<{ session: SessionSnapshot | null }> {
    return this.machine.request("/board/agent");
  }

  /** The one there is, else a new one; `replace` retires the one there is first. Answers launch refusals as createSession does. */
  startBoardAgent(body: { agent: string; customAgent?: string | null; replace?: boolean }): Promise<{ session: SessionSnapshot }> {
    return this.machine.request("/board/agent", { method: "POST", body: JSON.stringify(body) });
  }

  /** Another machine's config agent replaced this one's. */
  retireBoardAgent(): Promise<{ retired: boolean }> {
    return this.machine.request("/board/agent", { method: "DELETE" });
  }

  /** A first start or another attempt; an empty body launches what the task was created with. */
  /** Naming an agent or a folder assigns it: the task holds them for the next start too. */
  startTask(
    id: string,
    body: { agent?: string; customAgent?: string | null; cwd?: string } = {},
  ): Promise<{ task: TaskSnapshot; session: SessionSnapshot; sent: boolean }> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(body) });
  }

  /** `needs_you` is refused: the daemon alone says it. An assignee or a folder is weighed as a start weighs one. */
  changeTask(id: string, change: TaskChangeBody): Promise<{ task: TaskSnapshot }> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) });
  }

  deleteTask(id: string): Promise<{ deleted: boolean }> {
    return this.machine.request(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  attachSession(taskId: string, sessionId: SessionId): Promise<{ task: TaskSnapshot }> {
    return this.machine.request(`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "PUT" });
  }

  detachSession(taskId: string, sessionId: SessionId): Promise<{ task: TaskSnapshot }> {
    return this.machine.request(`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  /** The only read carrying complete model lists; the polled list truncates them. */
  session(id: SessionId): Promise<{ session: SessionSnapshot }> {
    return this.machine.request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}`);
  }

  stopSession(id: SessionId): Promise<{ session: SessionSnapshot }> {
    return this.machine.request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  resumeSession(id: SessionId): Promise<{ resumed: boolean; session: SessionSnapshot }> {
    return this.machine.request<{ resumed: boolean; session: SessionSnapshot }>(
      `/sessions/${encodeURIComponent(id)}/resume`,
      { method: "POST" },
    );
  }

  /** Not a slow route: the daemon bounds its own wait. cancelled false means nothing was running, which is a success. */
  cancelTurn(id: SessionId): Promise<{
    cancelled: boolean;
    turn: number | null;
    settled: boolean;
    session: SessionSnapshot;
  }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** stopped false is a success: the task finished first. A 404 means the task, or the route, is unknown. */
  stopBackgroundTask(id: SessionId, taskId: string): Promise<{ stopped: boolean; session: SessionSnapshot }> {
    return this.machine.request(
      `/sessions/${encodeURIComponent(id)}/async-tasks/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
    );
  }

  /** 202 with the prompt's seq; steered or queued say how it landed, never whether it worked. */
  prompt(
    id: SessionId,
    text: string,
    attachments: readonly string[] = [],
  ): Promise<{
    accepted: boolean;
    turn?: number | null;
    seq: number;
    steered?: boolean;
    queued?: boolean;
    id?: string;
    position?: number;
    session: SessionSnapshot;
  }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      // Omit the key when empty, so an older daemon sees the body it always saw.
      body: JSON.stringify(attachments.length === 0 ? { text } : { text, attachments }),
    });
  }

  /** Name in the query and mime in Content-Type: the relay's preflight allows no custom header. */
  uploadFile(
    id: SessionId,
    file: File,
    name: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<UploadAccepted> {
    const path = `/sessions/${encodeURIComponent(id)}/uploads?name=${encodeURIComponent(name)}`;
    return this.machine.upload<UploadAccepted>(path, file, onProgress, signal);
  }

  /** Probed with no body, because an old daemon's 404 does not survive an archive through the relay. Not a version check. */
  async importSupported(): Promise<boolean> {
    try {
      await this.machine.request("/fs/import", { method: "POST" });
      return true;
    } catch (error) {
      // Only the envelope-free 404 means the route is absent.
      if (error instanceof ApiError) return !(error.status === 404 && error.code === `http_${error.status}`);
      throw error;
    }
  }

  importArchive(
    path: string,
    file: File,
    name: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<ImportAccepted> {
    const query = `path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`;
    return this.machine.upload<ImportAccepted>(`/fs/import?${query}`, file, onProgress, signal);
  }

  plugins(): Promise<PluginListing> {
    return this.machine.request<PluginListing>("/plugins");
  }

  installPlugin(
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<PluginInstalled> {
    return this.machine.upload<PluginInstalled>(`/plugins?name=${encodeURIComponent(file.name)}`, file, onProgress, signal);
  }

  /** The daemon fetches the archive itself, and refuses before starting the plugin if its manifest disagrees with consent. */
  installPluginFromSource(
    source: { kind: "github"; repo: string; commit: string },
    consent: { scopes: readonly string[]; net: readonly string[]; hooks: readonly string[]; adds: readonly string[] } | null,
    signal?: AbortSignal,
  ): Promise<PluginInstalled> {
    return this.machine.request<PluginInstalled>("/plugins/source", {
      method: "POST",
      body: JSON.stringify({ source, ...(consent === null ? {} : { consent }) }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  removePlugin(pluginId: string): Promise<{ removed: boolean }> {
    return this.machine.request<{ removed: boolean }>(`/plugins/${encodeURIComponent(pluginId)}`, { method: "DELETE" });
  }

  setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ plugin: PluginSummary }> {
    return this.machine.request<{ plugin: PluginSummary }>(`/plugins/${encodeURIComponent(pluginId)}/state`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
  }

  pluginView(pluginId: string, view: "screen" | "settings"): Promise<{ result: PluginResult }> {
    return this.machine.request<{ result: PluginResult }>(
      `/plugins/${encodeURIComponent(pluginId)}/views/${view}`,
    );
  }

  pluginAction(
    pluginId: string,
    actionId: string,
    context: { session?: SessionId; row?: string; form?: Record<string, string> },
  ): Promise<{ result: PluginResult }> {
    return this.machine.request<{ result: PluginResult }>(
      `/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}`,
      { method: "POST", body: JSON.stringify(context) },
    );
  }

  downloadFile(id: SessionId, rel: string): Promise<Blob> {
    return this.machine.download(`/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(rel)}`);
  }

  downloadUpload(id: SessionId, uploadId: string): Promise<Blob> {
    return this.machine.download(
      `/sessions/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}`,
    );
  }

  answerPermission(
    id: SessionId,
    permissionId: string,
    option: PermissionOptionSummary,
  ): Promise<PermissionAnswerResult> {
    return this.machine.request<PermissionAnswerResult>(
      `/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: "POST", body: JSON.stringify({ optionId: option.optionId }) },
    );
  }

  cancelPermission(id: SessionId, permissionId: string): Promise<PermissionAnswerResult> {
    return this.machine.request<PermissionAnswerResult>(
      `/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: "POST", body: JSON.stringify({ cancel: true }) },
    );
  }

  elicitationForm(id: SessionId, elicitationId: string): Promise<{ fields: ElicitationField[] }> {
    return this.machine.request<{ fields: ElicitationField[] }>(
      `/sessions/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(elicitationId)}`,
    );
  }

  /** decline runs the tool with empty answers and the turn goes on; cancel aborts the tool call. */
  answerElicitation(
    id: SessionId,
    elicitationId: string,
    answer: { content: Record<string, ContentValue> } | { decline: true } | { cancel: true },
  ): Promise<ElicitationAnswerResult> {
    return this.machine.request<ElicitationAnswerResult>(
      `/sessions/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(elicitationId)}`,
      { method: "POST", body: JSON.stringify(answer) },
    );
  }

  /** Render the returned state, not the request: a model change can reset the mode. */
  setConfig(
    id: SessionId,
    body: { modeId: string } | { configId: string; value: string | boolean },
  ): Promise<{ config: AgentConfig; session: SessionSnapshot }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/config`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  commands(id: SessionId): Promise<{ revision: number; commands: AgentCommand[]; dropped: number }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/commands`);
  }

  /** 503 `peers_unavailable` without messaging; an older daemon answers the bare 404 `meansRouteAbsent` reads. */
  mentions(id: SessionId): Promise<MentionListing> {
    return this.machine.request<MentionListing>(`/sessions/${encodeURIComponent(id)}/mentions`);
  }

  /** Absent leaves a field alone and null clears it. Keep rank declared: nothing else mirrors the route's fields. */
  setSessionMeta(
    id: SessionId,
    patch: { title?: string | null; pinned?: boolean; rank?: number | null; nickname?: string; peerMessages?: boolean },
  ): Promise<{ session: SessionSnapshot }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/meta`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  /** since is exclusive, and a short page is not the end: always page by the last seq. */
  events(id: SessionId, since: number, limit = 200): Promise<EventsPage> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    return this.machine.request<EventsPage>(`/sessions/${encodeURIComponent(id)}/events?${query.toString()}`);
  }
}

export interface PermissionAnswerResult {
  recorded: boolean;
  permissionId: string;
  outcome: "selected" | "cancelled";
  optionId: string | null;
  by: string;
  /** `true` on the 409 path: the answer already landed. That is success. */
  repeat: boolean;
  delivered?: "sent" | "agent_gone";
  seq?: number | null;
  session: SessionSnapshot;
}

export interface ElicitationAnswerResult {
  recorded: boolean;
  elicitationId: string;
  action: "accept" | "decline" | "cancel";
  by: string;
  /** `true` on the 409 path: the answer already landed. That is success. */
  repeat: boolean;
  delivered?: "sent" | "agent_gone";
  seq?: number | null;
  session: SessionSnapshot;
}
