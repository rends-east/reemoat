import { ApiError } from "./http";
import type { CredentialWritten } from "./wire";
import type { ContentValue } from "./elicitation";
import type { SessionId } from "./ids";
import type { MachineConnection } from "./machine";
import type {
  AgentAuthListing,
  AgentCapabilities,
  AgentCommand,
  AgentConfig,
  AgentId,
  AgentInfo,
  CustomAgent,
  SystemInfo,
  DirListing,
  ElicitationField,
  EventsPage,
  LoginChunk,
  LoginRunView,
  PermissionOptionSummary,
  RootListing,
  SessionList,
  SessionSnapshot,
  ImportAccepted,
  PluginInstalled,
  PluginListing,
  PluginResult,
  PluginSummary,
  UploadAccepted,
} from "./wire";

/**
 * The daemon's HTTP surface, bound to one machine.
 *
 * Every method takes a `SessionId` and the machine is closed over, so there is no
 * function in the client that accepts a session id and a base URL as separate
 * arguments. That is the third of the three rules in `ids.ts`, and it is the one
 * that actually prevents the bug: a session id cannot reach the wrong daemon
 * because there is nowhere to pass the wrong daemon *to*.
 */
export class DaemonClient {
  constructor(private readonly machine: MachineConnection) {}

  agents(): Promise<{ agents: AgentInfo[] }> {
    return this.machine.request<{ agents: AgentInfo[] }>("/agents");
  }

  /* ---------------------------------------------------------------- *
   * Systems, and the agents assembled out of them
   *
   * ⚠ **`systems()` and `customAgents()` are cheap; `agentCapabilities()` is
   * not.** The first two are a table and a table; the third starts an agent per
   * harness on the daemon's host to read what each offers. That is why the New
   * session strip calls the first two on every open and only the builder calls
   * the third.
   * ---------------------------------------------------------------- */

  systems(): Promise<{ systems: SystemInfo[] }> {
    return this.machine.request<{ systems: SystemInfo[] }>("/systems");
  }

  saveSystemKey(system: string, token: string): Promise<{ saved: true; system: string }> {
    return this.machine.request(`/systems/${encodeURIComponent(system)}`, {
      method: "PUT",
      body: JSON.stringify({ token }),
    });
  }

  removeSystemKey(system: string): Promise<{ removed: true; system: string }> {
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

  /**
   * Save an agent somebody assembled, and overwrite one they had already saved.
   *
   * ⚠ **Two routes carrying the same four fields, and a `PUT` is what neither of
   * them is.** Half of the stored row is the daemon's own — `id` is minted there
   * and `createdAt` is when it was — so a route that took a whole agent would
   * either invite this client to send an id it did not mint, or accept one and
   * drop it. The body is the same either way and the *verb* is the whole
   * difference between adding an agent and editing one.
   *
   * ⚠ **`signal` is not decoration, and the failure it prevents was measured one
   * screen over.** `installPluginFromSource` shipped without it and was the only
   * install in this client that could not be called off — invisibly, because a
   * closure that omits a trailing parameter is still assignable to the type that
   * declares it. `request` already composes a caller's signal with its own
   * deadline (`withTimeout(timeout, init.signal)`), so the whole cost here is a
   * spread, and it is declared **before** the screen grows a Cancel rather than
   * after: the missing parameter is what makes the control unbuildable.
   *
   * Neither is replayable and neither has to say so: `isReplayable` in
   * `machine.ts` is GET/DELETE only, so a POST or a PATCH that times out is
   * never sent a second time and cannot save two copies of one agent. Both do
   * need `slowRoute`'s budget, and for a reason that is not obvious from the
   * body — the daemon re-weighs the pairing against what the harness accepts,
   * which means starting that harness on its host before it can answer.
   */
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

  /**
   * Drop a stored preset, and be able to say so twice.
   *
   * ⚠ **`removed: boolean`, not `true`, and the difference is the whole point of
   * the type.** `isReplayable` in `machine.ts` whitelists `DELETE`, and this route
   * is deliberately not on `slowRoute` — so it runs on `REQUEST_TIMEOUT_MS`, the
   * budget `settleTransport` names as the one an ordinary drop to LTE earns, and
   * a lost *answer* is resent as an identical request. The second send finds
   * nothing under the id because the first one worked. A daemon answering `404`
   * there would put `errorText` on the builder's screen over an act that
   * succeeded; the daemon answers `200 {removed: false}` instead, exactly as
   * {@link removePlugin} already does, and `false` is what tells a replay from a
   * mistyped id.
   *
   * Nobody reads it yet — `AgentBuilder` navigates away on either value, which is
   * right: the row is gone in both cases and there is nothing different to say.
   * The field is typed honestly anyway, because a `true` literal here is a
   * promise the wire stopped making and the way it would be discovered is a
   * screen quietly narrowing an answer it never checked.
   */
  removeCustomAgent(id: string): Promise<{ removed: boolean; id: string }> {
    return this.machine.request(`/custom-agents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /* ---------------------------------------------------------------- *
   * Logging an agent in
   *
   * Two paths, because neither alone is enough. The wizard runs the agent's own
   * login under a pty on the daemon's host and is nicer when it works; pasting a
   * token always works, and is the only option for a flow that insists on a
   * browser callback nothing here can receive.
   * ---------------------------------------------------------------- */

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

  /**
   * One line to the flow's stdin.
   *
   * HTTP rather than the stream, and the response is the point: a login code is
   * sent once and unrecoverable if it evaporates, which is exactly what
   * `ws.send()` into a half-open socket does silently.
   */
  writeLogin(loginId: string, text: string): Promise<LoginRunView> {
    return this.machine.request<LoginRunView>(
      `/agent-auth/login/${encodeURIComponent(loginId)}/input`,
      { method: "POST", body: JSON.stringify({ text }) },
    );
  }

  /**
   * Signs the agent's CLI out and clears the token we held for it.
   *
   * Both, because the login probe runs *with* a pasted credential in its
   * environment — so a sign-out that left one behind would report "signed in" a
   * second later and read as a button that did nothing.
   */
  signOut(agent: string): Promise<{ signedOut: boolean; credentialsCleared: number }> {
    return this.machine.request(`/agent-auth/${encodeURIComponent(agent)}/logout`, {
      method: "POST",
    });
  }

  cancelLogin(loginId: string): Promise<{ cancelled: boolean }> {
    return this.machine.request(`/agent-auth/login/${encodeURIComponent(loginId)}`, {
      method: "DELETE",
    });
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

  /**
   * Create one directory, so a session can start somewhere that does not exist.
   *
   * `parent` and `name` separately, never a joined path: the daemon validates
   * `name` as a single segment, so there is nothing to normalize and nothing to
   * traverse with.
   */
  makeDir(parent: string, name: string): Promise<{ path: string }> {
    return this.machine.request<{ path: string }>("/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    });
  }

  /**
   * The session list, bounded.
   *
   * `limit` is what keeps this affordable: the daemon retains 200 sessions and
   * every row is a full snapshot, and this is polled every few seconds per machine
   * from a phone. With a limit the daemon returns them blocked-first, then live,
   * then most-recent terminal — so the rows a cut drops are the ones nobody is
   * waiting on.
   *
   * `truncated` matters as much as `sessions`: without it a caller cannot tell a
   * session that is *gone* from one that is merely outside the window, and pruning
   * on that mistake throws away live state.
   *
   * An older daemon answers without `total`/`truncated` and ignores the query
   * parameter, which is why both are optional here.
   *
   * `now` is the daemon's own clock. Elapsed times are computed against it rather
   * than the browser's, because a phone's clock is exactly the thing that drifts
   * while it is asleep — and "blocked for 4 minutes" turning into "blocked for
   * −2 minutes" on wake is both wrong and alarming.
   */
  listSessions(limit?: number): Promise<SessionList> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    return this.machine.request<SessionList>(`/sessions${query}`);
  }

  createSession(body: {
    /**
     * The harness, or — when `customAgent` is given — ignored.
     *
     * The daemon fills it in from the preset rather than making the caller keep
     * the two in step, so a body sending both cannot produce a session running
     * something neither field named.
     */
    agent: string;
    /** An assembled agent's id, for a session that is not on a bare harness. */
    customAgent?: string | null;
    cwd: string;
    worktree?: boolean | "auto" | "require" | "never";
    branch?: string;
  }): Promise<{ session: SessionSnapshot }> {
    return this.machine.request<{ session: SessionSnapshot }>("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Stopping is a DELETE. There is no `POST /stop`. */
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

  /**
   * Stop the turn in flight. The session, the agent and the conversation stay.
   *
   * A `POST` on a sub-resource where stopping the whole session is a `DELETE`,
   * and the pair reads correctly: one removes the thing, the other acts on it.
   *
   * Not on `slowRoute`, deliberately — every other route that talks to a running
   * agent is there, and this one answers without waiting for the agent to agree.
   * The daemon bounds its own wait an order of magnitude under the default budget
   * (see `CANCEL_SETTLE_MS`), so a 15s deadline here is loose rather than tight,
   * and a cancel that needed 90 seconds would be one nobody would still be
   * looking at.
   *
   * `cancelled: false` is a **success**: nothing was running. See the route.
   */
  cancelTurn(id: SessionId): Promise<{
    cancelled: boolean;
    turn: number | null;
    settled: boolean;
    session: SessionSnapshot;
  }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** 202 on success, carrying the seq at which the prompt landed in the log. */
  prompt(
    id: SessionId,
    text: string,
    attachments: readonly string[] = [],
  ): Promise<{ accepted: boolean; turn: number; seq: number; session: SessionSnapshot }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/prompt`, {
      method: "POST",
      // The key is omitted entirely when there is nothing to send, so a daemon
      // that predates attachments sees a byte-identical body to the one it has
      // always seen rather than an empty array it does not know to ignore.
      body: JSON.stringify(attachments.length === 0 ? { text } : { text, attachments }),
    });
  }

  /**
   * Stage a file for a later prompt.
   *
   * The name rides the query string and the mime rides `Content-Type`, because
   * `CORS_ALLOW_HEADERS` is `authorization` and `content-type` and the relay
   * answers preflights from that same list — a custom header would need the
   * daemon, the relay and a control-plane redeploy before any browser could send
   * it.
   */
  uploadFile(
    id: SessionId,
    file: File,
    /**
     * The name to store it under, which is **not** always `file.name`.
     *
     * A pasted screenshot can arrive nameless, and an empty `?name=` is a `400
     * invalid_name`. The caller decides — see `pastedName` — so the chip on
     * screen and the name on disk are the same string by construction rather
     * than by two pieces of code agreeing.
     */
    name: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<UploadAccepted> {
    const path = `/sessions/${encodeURIComponent(id)}/uploads?name=${encodeURIComponent(name)}`;
    return this.machine.upload<UploadAccepted>(path, file, onProgress, signal);
  }

  /**
   * Whether this daemon has the import route at all, asked before any bytes move.
   *
   * **A 404 does not survive an archive.** Measured against a daemon predating
   * this route, through a real relay: a 5 MiB `POST /fs/import` came back as
   * `502 tunnel_failed` after 3.4 MB, not as the 404 the same request answers
   * with an empty body. The daemon refuses — no such route, and its 1 MiB body
   * bound would refuse anyway — **without draining the request body**, so its end
   * of the tunnel stream dies mid-upload and the relay reports the only thing it
   * can see, which is that the stream failed. The honest sentence about an old
   * daemon was therefore unreachable in exactly the case it exists for.
   *
   * So the question is asked with **no body**, where the answer comes back
   * intact: a daemon with the route answers `400 bad_request` (there is no
   * `?path=`), one without it answers a bare 404 carrying no envelope. One small
   * round trip in front of a multi-megabyte upload is not a cost worth measuring.
   *
   * Deliberately **not** a version check. `DAEMON_VERSION` is a label and nothing
   * may branch on it — see `compatibility.md`. This asks the route whether it is
   * there, which is the question actually being asked.
   */
  async importSupported(): Promise<boolean> {
    try {
      await this.machine.request("/fs/import", { method: "POST" });
      return true;
    } catch (error) {
      // An envelope means this daemon knows the route and refused on its merits.
      // Only the envelope-free 404 means the route is absent.
      if (error instanceof ApiError) return !(error.status === 404 && error.code === `http_${error.status}`);
      throw error;
    }
  }

  /**
   * Unpack an archive of somebody's project into a directory on this machine.
   *
   * Not a session route: this is how a folder worth starting a session *in* comes
   * to exist, so it happens on the new-session screen before there is an id to
   * hang it off. Both parameters ride the query string for `uploadFile`'s reason
   * one method up — the relay answers preflights from a fixed header list.
   *
   * Goes through `upload` rather than `request` for the same reason an attachment
   * does: it is the only path in this client that reports progress, and an
   * archive is the one thing here big enough that a bar is the difference between
   * waiting and reloading.
   */
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

  /* ---------------------------------------------------------------- *
   * Plugins
   * ---------------------------------------------------------------- */

  plugins(): Promise<PluginListing> {
    return this.machine.request<PluginListing>("/plugins");
  }

  /**
   * Install a plugin, or update one — the same call, because they are one act.
   *
   * Through `upload` rather than `request` for `importArchive`'s reason one method
   * up: it is the only path in this client that reports progress, and a person
   * watching an archive move wants to see it move. The name rides the query string
   * because the relay answers preflights from a fixed header list.
   */
  installPlugin(
    file: File,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<PluginInstalled> {
    return this.machine.upload<PluginInstalled>(`/plugins?name=${encodeURIComponent(file.name)}`, file, onProgress, signal);
  }

  /**
   * Install a plugin the *daemon* fetches, from a commit the catalogue pinned.
   *
   * ⚠ **The browser cannot be the courier here, and that is measured rather than
   * chosen.** `codeload.github.com` answers `access-control-allow-origin:
   * https://render.githubusercontent.com`, so a cross-origin fetch for the
   * archive is refused before it leaves this page — there is no header the
   * catalogue could send that would change it. So the machine fetches its own
   * bytes, and what crosses this wire is a repository, a commit, and what the
   * person was shown.
   *
   * `consent` is what the disclosure screen actually drew, read from
   * `plugin.json` at that same commit. The daemon compares its own parse against
   * it and refuses with `plugin_consent_broken` **before starting the plugin** —
   * which is stronger than the upload path's after-the-fact `consentBroken`, and
   * has to be, because nothing in this browser ever opened the archive.
   *
   * ⚠ **`signal` is not optional decoration: without it this route was the one
   * install in the client that could not be called off.** `request` already
   * composes a caller's signal with its own deadline (`withTimeout(timeout,
   * init.signal)`), so the plumbing was there and only this method declined to
   * use it — which is invisible from the call site, because a `MachineInstalls`
   * install closure that simply omits the parameter is still assignable to
   * `InstallAct`. The daemon unpacks and starts the plugin either way, so an
   * un-abortable fan-out is a plugin arriving on machines after somebody pressed
   * Cancel.
   *
   * Answers `PluginInstalled`, exactly as {@link installPlugin} does, down to
   * `replaced`. It is the same act on the same host reached by a different door,
   * and a caller that can read one answer can read the other.
   */
  installPluginFromSource(
    source: { kind: "github"; repo: string; commit: string },
    consent: { scopes: readonly string[]; net: readonly string[]; hooks: readonly string[] } | null,
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

  /**
   * What one of a plugin's screens draws right now.
   *
   * A `GET`, so `isReplayable` lets the transport repeat it — which is the wire's
   * way of saying a view must be a read. The plugin's contract, not this client's
   * to enforce.
   */
  pluginView(pluginId: string, view: "screen" | "settings"): Promise<{ result: PluginResult }> {
    return this.machine.request<{ result: PluginResult }>(
      `/plugins/${encodeURIComponent(pluginId)}/views/${view}`,
    );
  }

  /**
   * Press something on a plugin.
   *
   * All three pieces of context are optional and the surface decides which are
   * sent: `session` from a session's menu, `row` from a row on the plugin's own
   * screen, `form` from a form's submit.
   */
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

  /** The bytes of one file in the session's tree, by workspace-relative path. */
  downloadFile(id: SessionId, rel: string): Promise<Blob> {
    return this.machine.download(`/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(rel)}`);
  }

  /** The bytes of something staged for a prompt, which lives outside the workspace. */
  downloadUpload(id: SessionId, uploadId: string): Promise<Blob> {
    return this.machine.download(
      `/sessions/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}`,
    );
  }

  /**
   * Answer a permission with one of the agent's own options.
   *
   * `{optionId}` rather than `{decision}` deliberately: the buttons show the
   * agent's own labels, so the answer should be the option the human actually
   * pressed and not a word this client mapped it onto afterwards.
   */
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

  /**
   * The form behind a pending question.
   *
   * Fetched rather than read off the snapshot, and that is the daemon's decision
   * restated here so nobody goes looking for the fields on `SessionSnapshot`: a
   * permission earns its place there because a blocked session must be answerable
   * *from the list*, and a question is not — you have to read the form. Same
   * arrangement the command list has.
   */
  elicitationForm(id: SessionId, elicitationId: string): Promise<{ fields: ElicitationField[] }> {
    return this.machine.request<{ fields: ElicitationField[] }>(
      `/sessions/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(elicitationId)}`,
    );
  }

  /**
   * Answer a question — or skip it, or abandon the tool call that asked.
   *
   * One method rather than three: `answerPermission`/`cancelPermission` are two
   * only because one takes an option and the other takes nothing, and here the
   * three forms are already a union.
   *
   * The distinction between `decline` and `cancel` is measured rather than
   * cosmetic: declining runs the tool with empty answers and the turn *carries
   * on*, while cancelling aborts the tool call.
   */
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

  /**
   * Change one of the agent's controls: mode, model, reasoning effort.
   *
   * The response is the agent's *own* refreshed state, not an echo — setting a
   * model rebuilds the available modes and can reset the current one — so the
   * caller must render what comes back rather than what it asked for.
   */
  setConfig(
    id: SessionId,
    body: { modeId: string } | { configId: string; value: string | boolean },
  ): Promise<{ config: AgentConfig; session: SessionSnapshot }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/config`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * What the agent will answer to a leading slash.
   *
   * Its own request rather than a field on the snapshot, because the snapshot
   * arrives for every session on every poll — see `SessionSnapshot.commandsRevision`,
   * which is the number that says when to call this. The ordinary 15s budget and
   * not the 90s one: nothing here spawns a process.
   *
   * `revision` comes back so a caller can notice the list moved while the request
   * was in flight and refetch, rather than filing what it got under a revision
   * that has already been superseded.
   */
  commands(id: SessionId): Promise<{ revision: number; commands: AgentCommand[]; dropped: number }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/commands`);
  }

  /**
   * Rename a session, or pin it to the top of its machine's section.
   *
   * An absent field means "leave it alone"; `title: null` clears the name, which
   * re-arms the daemon's derivation from the next prompt. The response is the
   * whole snapshot rather than an echo, because a title is normalized on the way
   * in and what was asked for is not necessarily what was stored.
   *
   * `POST` on a sub-resource rather than `PATCH` on the session: `PATCH` would
   * mean adding a verb to the daemon's shared CORS method list, which the relay
   * also answers preflights with, for no gain over a `POST` that reads the same.
   */
  setSessionMeta(
    id: SessionId,
    patch: { title?: string | null; pinned?: boolean },
  ): Promise<{ session: SessionSnapshot }> {
    return this.machine.request(`/sessions/${encodeURIComponent(id)}/meta`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  /**
   * A page of history. `since` is **exclusive** — `seq > since`.
   *
   * The server caps a page at 500 events *or* 2 MiB, whichever comes first, so a
   * short page does not mean the end. Always page by the last event's `seq`.
   */
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
