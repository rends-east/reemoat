import { readFile } from "node:fs/promises";

import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeRequestable,
  safeRelPath,
} from "../changes.js";

import { AgentAskError, type AgentAskRuns } from "../agentask.js";
import type { GitExec } from "../git.js";
import type { ElicitationContentValue, ManagedSession, SessionRegistry } from "../registry.js";
import { DESCRIBE_TIMEOUT_MS, probeFile } from "../stall.js";
import type { PluginOrigins } from "./origin.js";
import type { PluginManifest, PluginScope } from "./protocol.js";
import { MAX_PLUGIN_MESSAGE_BYTES } from "./runtime.js";
import { PluginStoreError, type PluginDataStore } from "./store.js";

// The plugin API and its scope gate: hygiene rather than a fence, since a plugin is a child process running as this uid.

const MAX_PLUGIN_FILE_BYTES = 64 * 1024;

const MAX_PLUGIN_EVENTS = 500;
const MAX_PLUGIN_EVENT_BYTES = 128 * 1024;

// A page rather than the quota: a full 1 MiB store would not fit the 256 KiB channel, so half the channel.
const MAX_PLUGIN_ENTRY_BYTES = 128 * 1024;

const MAX_PLUGIN_LOG_CHARS = 500;

// A quarter of the channel: the body is re-escaped as JSON beside the headers, and anything larger could never be delivered.
export const MAX_PLUGIN_FETCH_BYTES = MAX_PLUGIN_MESSAGE_BYTES / 4;

const PLUGIN_FETCH_TIMEOUT_MS = 10_000;
const PLUGIN_FETCH_BURST = 30;
const PLUGIN_FETCH_WINDOW_MS = 60_000;

// Each ask spawns an agent, hence far fewer than net.fetch; the daemon-wide concurrency cap lives in AgentAskRuns.
const PLUGIN_ASK_BURST = 6;
const PLUGIN_ASK_WINDOW_MS = 60_000;

interface PluginBudget {
  readonly windows: Map<string, number[]>;
  readonly burst: number;
  readonly windowMs: number;
  readonly code: string;
  readonly refusal: string;
}

export class PluginApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginApiError";
  }
}

/** Which scope each method needs. The absence of a method here is a refusal. */
const SCOPE_OF: Record<string, PluginScope | null> = {
  log: null,
  "sessions.list": "sessions.read",
  "sessions.get": "sessions.read",
  "sessions.events": "sessions.read",
  "sessions.changes": "sessions.read",
  "sessions.diff": "sessions.read",
  "sessions.workspace": "sessions.read",
  "sessions.create": "sessions.write",
  "sessions.prompt": "sessions.write",
  "sessions.cancel": "sessions.write",
  "sessions.stop": "sessions.write",
  "sessions.setMeta": "sessions.write",
  "sessions.answerPermission": "sessions.write",
  "sessions.answerElicitation": "sessions.write",
  "agents.list": "sessions.read",
  "files.read": "files.read",
  "store.get": "store",
  "store.set": "store",
  "store.delete": "store",
  "store.keys": "store",
  "store.entries": "store",
  "net.fetch": "net",
  // The only method that spends the operator's quota; PLUGIN_SCOPE_TEXT in packages/web/src/wire.ts must say so.
  "model.complete": "model",
  "model.list": "model",
};

export interface PluginApiOptions {
  registry: SessionRegistry;
  data: PluginDataStore;
  git: GitExec;
  maxChangedFiles?: number | undefined;
  maxDiffBytes?: number | undefined;
  onWarning?: (detail: string) => void;
  fetchImpl?: typeof fetch;
  /** Stamps this plugin's writes so its own echo is not fanned back to it; absent when no plugin host exists. */
  origins?: PluginOrigins;
  ask?: AgentAskRuns;
}

export class PluginApi {
  private readonly fetchBudget: PluginBudget = {
    windows: new Map(),
    burst: PLUGIN_FETCH_BURST,
    windowMs: PLUGIN_FETCH_WINDOW_MS,
    code: "fetch_rate_limited",
    refusal: `a plugin may make ${PLUGIN_FETCH_BURST} requests a minute`,
  };
  private readonly askBudget: PluginBudget = {
    windows: new Map(),
    burst: PLUGIN_ASK_BURST,
    windowMs: PLUGIN_ASK_WINDOW_MS,
    code: "model_rate_limited",
    refusal: `a plugin may make ${PLUGIN_ASK_BURST} model requests a minute`,
  };

  constructor(private readonly options: PluginApiOptions) {}

  async call(manifest: PluginManifest, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!Object.hasOwn(SCOPE_OF, method)) {
      throw new PluginApiError("unknown_method", `there is no ${method}`);
    }
    const needed = SCOPE_OF[method] ?? null;
    if (needed !== null && !manifest.scopes.includes(needed)) {
      this.options.onWarning?.(
        `plugin ${manifest.id} called ${method} without the ${needed} scope`,
      );
      throw new PluginApiError(
        "plugin_scope_denied",
        `${method} needs the "${needed}" scope, which this plugin does not declare`,
      );
    }
    const input = (args ?? {}) as Record<string, unknown>;
    return this.run(manifest, method, input, signal);
  }

  // Only the two methods that spawn an agent honour signal; every other arm finishes on its own.
  private async run(
    manifest: PluginManifest,
    method: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { registry } = this.options;

    switch (method) {
      case "log": {
        this.options.onWarning?.(`plugin ${manifest.id}: ${clip(String(input["message"] ?? ""), MAX_PLUGIN_LOG_CHARS)}`);
        return null;
      }

      case "sessions.list":
        return registry.list().map((session) => summarize(session));

      case "sessions.get":
        return summarize(this.session(input));

      case "sessions.events": {
        const managed = this.session(input);
        const since = whole(input["since"], 0);
        const limit = Math.min(whole(input["limit"], 100), MAX_PLUGIN_EVENTS);
        return managed.log.read(since, limit, MAX_PLUGIN_EVENT_BYTES);
      }

      case "sessions.changes": {
        const managed = this.session(input);
        const changes = await listChanges(managed.workspace, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          includeIgnored: false,
          limit: this.options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES,
        });
        return changes;
      }

      case "sessions.diff": {
        const managed = this.session(input);
        const path = text(input["path"], "path");
        // Recomputed from git's own list rather than trusted, as the diff route does: closes the race between listing and diffing.
        const changes = await listChanges(managed.workspace, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          includeIgnored: true,
          limit: this.options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES,
        });
        if (!changes.supported) throw new PluginApiError("not_a_git_repository", "that session is not in a git repository");
        const change = changes.files.find((file) => file.path === path);
        if (change === undefined) throw new PluginApiError("path_not_changed", "that session did not change that file");
        if (!change.addressable) {
          throw new PluginApiError("path_not_addressable", "that path is not valid UTF-8 and cannot be requested");
        }
        return diffFile(managed.workspace, change, {
          runner: this.options.git,
          base: input["base"] === "head" ? "head" : "session",
          contextLines: 3,
          maxBytes: this.options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
        });
      }

      case "sessions.workspace":
        return this.session(input).workspace;

      case "sessions.create": {
        const agent = text(input["agent"], "agent");
        const cwd = text(input["cwd"], "cwd");
        const raw = input["worktree"];
        const worktree =
          raw === true ? "require" : raw === false ? "never" : raw === "auto" || raw === "require" || raw === "never" ? raw : undefined;
        const branchRaw = input["branch"];
        const branch = typeof branchRaw === "string" && branchRaw.length > 0 ? branchRaw : null;
        try {
          // origin stops a session.created hook from recursing; it must be an argument because create announces before it returns.
          const managed = await registry.create({
            agent: agent as never,
            cwd,
            worktree,
            branch,
            origin: manifest.id,
          });
          return summarize(managed);
        } catch (error) {
          throw new PluginApiError("session_create_failed", error instanceof Error ? error.message : String(error));
        }
      }

      case "sessions.prompt": {
        const managed = this.session(input);
        // Parsed before the claim so a malformed body stamps nothing.
        const prompt = text(input["text"], "text");
        // Claim the turn before prompting (pump can append turn_end synchronously) and undo on refusal; cancel and stop are never stamped.
        // Wake a parked session first, as the prompt route does, and before the claim: a wake is not a turn.
        await registry.wakeForPrompt(managed);
        const undo = this.options.origins?.claimTurn(managed.id, manifest.id);
        const result = managed.prompt(prompt);
        if (result.kind !== "accepted") {
          undo?.();
          // A turn in flight stays session_busy: a steered message never produces the turn_end that spends the origin claim.
          const kind = result.kind === "turn_in_flight" ? "busy" : result.kind;
          throw new PluginApiError(`session_${kind}`, `that session would not take a prompt: ${kind}`);
        }
        return result;
      }

      case "sessions.cancel":
        return this.session(input).cancelTurn();

      case "sessions.stop": {
        const managed = this.session(input);
        await managed.stop("stopped");
        return summarize(managed);
      }

      case "sessions.setMeta": {
        const managed = this.session(input);
        const change: { title?: string | null; pinned?: boolean } = {};
        if (Object.hasOwn(input, "title")) {
          const title = input["title"];
          change.title = title === null ? null : text(title, "title");
        }
        if (Object.hasOwn(input, "pinned")) change.pinned = input["pinned"] === true;
        return managed.setMeta(change);
      }

      case "agents.list":
        return registry.sessionRuntime.availability();

      case "sessions.answerElicitation": {
        const managed = this.session(input);
        const elicitationId = text(input["elicitationId"], "elicitationId");
        const body =
          input["decline"] === true
            ? ({ decline: true } as const)
            : input["cancel"] === true
              ? ({ cancel: true } as const)
              : { content: (input["content"] ?? {}) as Record<string, ElicitationContentValue> };
        const result = managed.answerElicitation(elicitationId, body);
        if (result.kind === "invalid_content") {
          throw new PluginApiError("elicitation_invalid", JSON.stringify(result.problems));
        }
        return result;
      }

      case "sessions.answerPermission": {
        const managed = this.session(input);
        const optionId = text(input["optionId"], "optionId");
        const result = managed.answerPermission(text(input["permissionId"], "permissionId"), { optionId });
        if (result.kind === "not_found") throw new PluginApiError("permission_not_found", "no such question on that session");
        return result;
      }

      case "files.read": {
        const managed = this.sessionBy(text(input["sessionId"], "sessionId"));
        const requested = text(input["path"], "path");
        const safe = safeRelPath(managed.workspace.root, requested);
        if (!safe.ok) throw new PluginApiError("invalid_path", `that path is not inside the session's tree: ${safe.reason}`);
        // Re-tested after following symlinks: safeRelPath alone misses a g -> .git link.
        const answer = await probeRequestable(managed.workspace.root, safe.full);
        if (answer === null) {
          throw new PluginApiError("path_unresponsive", `the filesystem holding that path did not answer in ${DESCRIBE_TIMEOUT_MS}ms`);
        }
        if (answer !== "ok") throw new PluginApiError("invalid_path", `that path is not inside the session's tree: ${answer}`);

        const probe = await probeFile(safe.full);
        if (probe === null) throw new PluginApiError("path_unresponsive", "the filesystem holding that path did not answer");
        if (probe.kind !== "file") throw new PluginApiError("not_a_file", "that path is not a regular file");
        if (probe.size > MAX_PLUGIN_FILE_BYTES) {
          throw new PluginApiError("file_too_large", `a plugin may read at most ${MAX_PLUGIN_FILE_BYTES} bytes of a file`);
        }
        // Allowed only because the probe above just answered for this path.
        return readFile(safe.full, "utf8");
      }

      case "store.get":
        return this.options.data.get(manifest.id, text(input["key"], "key"));

      case "store.set": {
        const value = input["value"];
        try {
          // Serialised here so the quota counts the bytes that land in the row.
          this.options.data.set(manifest.id, text(input["key"], "key"), JSON.stringify(value ?? null));
        } catch (error) {
          if (error instanceof PluginStoreError) throw new PluginApiError(error.code, error.message);
          throw error;
        }
        return null;
      }

      case "store.delete":
        this.options.data.delete(manifest.id, text(input["key"], "key"));
        return null;

      case "store.keys": {
        const prefix = input["prefix"];
        return this.options.data.keys(manifest.id, typeof prefix === "string" ? prefix : "");
      }

      case "store.entries": {
        // after is the store's own cursor, echoed back rather than computed.
        const prefix = input["prefix"];
        const after = input["after"];
        return this.options.data.entries(
          manifest.id,
          typeof prefix === "string" ? prefix : "",
          typeof after === "string" ? after : "",
          MAX_PLUGIN_ENTRY_BYTES,
        );
      }

      case "net.fetch":
        return this.fetch(manifest, input);
      case "model.complete":
        return this.complete(manifest, input, signal);

      case "model.list":
        return this.listModels(manifest, input, signal);

      default:
        throw new PluginApiError("unknown_method", `there is no ${method}`);
    }
  }

  // The one outbound door a plugin has, limited to manifest.net hosts; src/ holds three fetch calls: enroll.ts, this, fetchArchive in plugins/source.ts.
  private async fetch(manifest: PluginManifest, input: Record<string, unknown>): Promise<unknown> {
    const raw = text(input["url"], "url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PluginApiError("invalid_url", "that is not a URL");
    }
    if (url.protocol !== "https:") throw new PluginApiError("insecure_url", "net.fetch speaks https only");
    if (!manifest.net.includes(url.hostname.toLowerCase())) {
      this.options.onWarning?.(`plugin ${manifest.id} tried to reach ${url.hostname}, which its manifest does not list`);
      throw new PluginApiError("host_not_allowed", `${url.hostname} is not in this plugin's net list`);
    }

    this.spend(this.fetchBudget, manifest.id);

    const init = (input["init"] ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    const rawHeaders = init["headers"];
    if (rawHeaders !== null && typeof rawHeaders === "object") {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        // Control characters dropped: a CR in a header value is request splitting.
        if (/[\x00-\x1f\x7f]/.test(String(value))) continue;
        headers[key] = String(value);
      }
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    const stop = AbortSignal.timeout(PLUGIN_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: typeof init["method"] === "string" ? (init["method"] as string) : "GET",
        headers,
        body: typeof init["body"] === "string" ? (init["body"] as string) : undefined,
        // No redirects: the approved allowlist names hosts, not chains.
        redirect: "manual",
        signal: stop,
      });
    } catch (error) {
      throw new PluginApiError("fetch_failed", error instanceof Error ? error.message : String(error));
    }

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PLUGIN_FETCH_BYTES) {
      // Cancel the body before throwing, or the socket is held until the timeout.
      await response.body?.cancel().catch(() => {
        // Already ended or already errored; there is nothing left to release.
      });
      throw new PluginApiError("response_too_large", `a plugin may read at most ${MAX_PLUGIN_FETCH_BYTES} bytes`);
    }
    // Charged per chunk: a chunked response has no content-length for the check above.
    const body = await readBounded(response, MAX_PLUGIN_FETCH_BYTES);
    const answer = { status: response.status, headers: Object.fromEntries(response.headers), body };
    // JSON escaping can outgrow the channel even under MAX_PLUGIN_FETCH_BYTES; the slack covers the answer envelope.
    if (Buffer.byteLength(JSON.stringify(answer), "utf8") > MAX_PLUGIN_MESSAGE_BYTES - 128) {
      throw new PluginApiError(
        "response_too_large",
        `that response does not fit the ${MAX_PLUGIN_MESSAGE_BYTES} bytes a plugin is answered in`,
      );
    }
    return answer;
  }

  // Fire-and-forget: the refusal code is the only failure report a plugin gets. ACP has no system prompt or token ceiling to offer.
  private async complete(
    manifest: PluginManifest,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ask = this.options.ask;
    if (ask === undefined) {
      throw new PluginApiError("model_unavailable", "this daemon cannot run model requests");
    }
    const agent = text(input["agent"], "agent");
    this.knownAgent(agent);
    const prompt = text(input["prompt"], "prompt");
    // Absent, null and empty all mean the agent's own default.
    const model = typeof input["model"] === "string" ? input["model"] : "";

    this.spend(this.askBudget, manifest.id);

    try {
      return await ask.ask(agent, prompt, model, signal);
    } catch (error) {
      if (error instanceof AgentAskError) throw new PluginApiError(error.code, error.message);
      throw new PluginApiError("model_failed", error instanceof Error ? error.message : String(error));
    }
  }

  // Spawns an agent, hence the model scope and the ask budget. An empty list is an answer: kimi offers no model control.
  private async listModels(
    manifest: PluginManifest,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ask = this.options.ask;
    if (ask === undefined) {
      throw new PluginApiError("model_unavailable", "this daemon cannot run model requests");
    }
    const agent = text(input["agent"], "agent");
    this.knownAgent(agent);
    this.spend(this.askBudget, manifest.id);
    try {
      return { models: await ask.models(agent, signal) };
    } catch (error) {
      if (error instanceof AgentAskError) throw new PluginApiError(error.code, error.message);
      throw new PluginApiError("model_failed", error instanceof Error ? error.message : String(error));
    }
  }

  // Unknown and disabled get different sentences: a switched-off plugin's id is not the author's bug.
  private knownAgent(agent: string): void {
    const machine = this.options.registry.machineCatalogue;
    switch (machine.harnessState(agent)) {
      case "enabled":
        return;
      case "disabled":
        throw new PluginApiError(
          "model_agent_unknown",
          `${JSON.stringify(agent)} comes from a plugin that is switched off on this machine`,
        );
      default:
        throw new PluginApiError("model_agent_unknown", `${JSON.stringify(agent)} is not an agent this daemon knows`);
    }
  }

  private spend(budget: PluginBudget, pluginId: string): void {
    const now = Date.now();
    for (const [id, at] of budget.windows) {
      const kept = at.filter((one) => now - one < budget.windowMs);
      // Sweep every plugin, not just the caller: nothing else would ever drop an uninstalled plugin's entry.
      if (kept.length === 0) budget.windows.delete(id);
      else budget.windows.set(id, kept);
    }

    const seen = budget.windows.get(pluginId) ?? [];
    if (seen.length >= budget.burst) throw new PluginApiError(budget.code, budget.refusal);
    seen.push(now);
    budget.windows.set(pluginId, seen);
  }

  private session(input: Record<string, unknown>): ManagedSession {
    return this.sessionBy(text(input["id"], "id"));
  }

  private sessionBy(id: string): ManagedSession {
    const managed = this.options.registry.get(id);
    if (managed === undefined) throw new PluginApiError("session_not_found", "no such session on this machine");
    return managed;
  }
}

function summarize(managed: ManagedSession): unknown {
  return managed.snapshot();
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginApiError("bad_request", `${field} must be a non-empty string`);
  }
  return value;
}

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

async function readBounded(response: Response, max: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      held += value.byteLength;
      if (held > max) {
        throw new PluginApiError("response_too_large", `a plugin may read at most ${max} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      // Already done or errored; nothing to release.
    });
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
