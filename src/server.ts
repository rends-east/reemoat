import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { IncomingMessage, Server } from "node:http";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context, type Handler, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { WSContext } from "hono/ws";
import type { WebSocket as RawWebSocket } from "ws";
import { AgentUnavailableError, claudeSettingsMode, isBuiltinAgentId, type AgentId } from "./acp/agents.js";
import {
  hostable,
  routedModelNaming,
  systemSecretFor,
  type CustomAgent,
  type SystemId,
  type AgentStripEntry,
  type SystemStores,
} from "./acp/systems.js";
import { AgentAskError, type AgentCapabilityReader } from "./agentask.js";
import type { AgentLoginSupport } from "./runtime/types.js";
import { isAuthRequiredMessage, SystemRoutingError } from "./session.js";
import { type AgentCredentialStore, type AgentLoginRuns } from "./agentauth.js";
import type { AgentInstallRuns } from "./agentinstall.js";
import { AUTH_LEEWAY_MS, hasScope, type Principal, type Scope, type TokenVerifier } from "./auth.js";
import {
  importArchive,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_UNPACKED_BYTES,
  PLUGIN_LIMITS,
  type ImportOutcome,
} from "./archive.js";
import { PluginApiError } from "./plugins/api.js";
import type { LivePlugin, PluginHost } from "./plugins/host.js";
import { PLUGIN_API_VERSION, type PluginResult } from "./plugins/protocol.js";
import { isSourceRefusal, readConsent, readSource } from "./plugins/source.js";
import { listDirs, makeDir, PathError, resolveCwd } from "./browse.js";
import { DESCRIBE_TIMEOUT_MS, probeExists, probeFile, probeRealpath } from "./stall.js";
import {
  cancelBody,
  contentDispositionFor,
  MAX_PROMPT_ATTACHMENTS,
  MAX_SESSION_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_SESSION,
  parseMime,
  sanitizeUploadName,
  UPLOAD_RATE_BYTES,
  UPLOAD_RATE_WINDOW_MS,
  type Uploads,
  type UploadRow,
} from "./uploads.js";
import { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_MAX_AGE_SECONDS } from "./cors.js";
import { RELAY_PROTOCOL_VERSION } from "./relay/protocol.js";
import { DAEMON_VERSION } from "./version.js";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeRequestable,
  safeRelPath,
} from "./changes.js";
import {
  clampBlob,
  estimateBytes,
  keepsItsConversation,
  oldestAvailable,
  type StoredEvent,
  type MachineSettingKey,
  isMachineSettingKey,
} from "./events.js";
import { GitError } from "./git.js";
import {
  bearerToken,
  boundedInt,
  describeError,
  errorEnvelope,
  gzipResponses,
  jsonError,
  readJsonObject,
} from "./http.js";
import { containedInResolved } from "./paths.js";
import { inspectWorkspace, listWorktrees, removeWorkspace, WorktreeError, type RemoveRefusal } from "./worktree.js";
import {
  awaitingHuman,
  describeResumeFailure,
  MAX_TITLE_CHARS,
  SessionLimitError,
  StartTimeoutError,
  type ElicitationAnswerBody,
  type ElicitationContentValue,
  type ManagedSession,
  type PermissionAnswer,
  type SessionRegistry,
  type SessionSnapshot,
  type WorktreePolicy,
  MAX_IDLE_RELEASE_MINUTES,
  type MachineSettingsPort,
} from "./registry.js";

const MAX_QUEUE_EVENTS = 8_000;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
// Well under MAX_QUEUE_EVENTS so a replay cannot collapse on count; one past MAX_QUEUE_BYTES still collapses, reported as backlog.
const ATTACH_REPLAY_MAX = 2_000;
const BATCH_MAX_EVENTS = 200;
// Largest events frame in UTF-8 bytes actually written, half of MAX_SOCKET_MESSAGE_BYTES.
const BATCH_MAX_BYTES = 512 * 1024;
/** Largest control frame in bytes written: past MAX_SOCKET_MESSAGE_BYTES the receiver fails the channel, so fitSnapshotFrame fits hello under it. */
export const CONTROL_MAX_BYTES = 512 * 1024;
const EVENTS_FRAME_OPEN = '{"type":"events","events":[';
const EVENTS_FRAME_CLOSE = "]}";
const SOCKET_HIGH_WATER = 1024 * 1024;
const PING_INTERVAL_MS = 20_000;
const COLLAPSE_WINDOW_MS = 30_000;
export const EVENTS_PAGE_LIMIT = 5_000;
// Must stay below STREAM_WINDOW_BYTES: a relayed page larger than one h2 window can wedge (Q6.104). Never raise it alone.
const EVENTS_PAGE_BYTES = 768 * 1024;
const MAX_PROMPT_CHARS = 100_000;
const MAX_CREDENTIAL_CHARS = 8_192;

const MAX_MODEL_CHARS = 256;

const MAX_AGENT_NAME_CHARS = 80;

const MACHINE_SETTING_RULES: Record<MachineSettingKey, (value: unknown) => string | null> = {
  idleReleaseMinutes: (value) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_IDLE_RELEASE_MINUTES
      ? null
      : `idleReleaseMinutes must be a whole number of minutes between 0 and ${MAX_IDLE_RELEASE_MINUTES}`,
};

// Must stay clear of the whole custom_agents list, which the strip screen writes on every action.
const MAX_STRIP_ENTRIES = 1_000;

// Must fit the longest contributed harness id, pluginId:localId at 32 chars each.
const MAX_STRIP_REF_CHARS = 96;

// Under the client's slow-route budget for this write (slowRouteTimeout), so a retried create cannot make a duplicate preset.
const CAPABILITY_READ_BUDGET_MS = 60_000;
const MAX_DIR_NAME_CHARS = 255;
const MAX_PATH_CHARS = 4_096;

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// Every route but the streaming ones (isStreamingRoute), which count their own bytes.
const MAX_BODY_BYTES = 1024 * 1024;

// POST routes that stream their body and count their own bytes: exempt from MAX_BODY_BYTES, and their body is cancelled whoever answers.
function isStreamingRoute(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return /^\/sessions\/[^/]+\/uploads$/.test(path) || path === "/fs/import" || path === "/plugins";
}

type AppEnv = { Variables: { principal: Principal } };

export interface ServerOptions {
  registry: SessionRegistry;
  verifier: TokenVerifier;
  instanceId: string;
  startedAt: number;
  maxChangedFiles?: number;
  maxDiffBytes?: number;
  credentials?: AgentCredentialStore;
  // Absent, every systems route answers 503 except GET /systems, whose table is compiled in.
  systems?: SystemStores;
  machineSettings?: MachineSettingsPort;
  asks?: AgentCapabilityReader;
  logins?: AgentLoginRuns;
  installs?: AgentInstallRuns;
  uploads?: Uploads;
  // Narrows the browse surface only; resolveCwd is deliberately not confined to these.
  roots?: string[];
  plugins?: PluginHost | null;
}

export interface AppBundle {
  app: Hono<AppEnv>;
  injectWebSocket: (server: Server) => void;
}

export function createApp(options: ServerOptions): AppBundle {
  const { registry, verifier, instanceId, startedAt } = options;
  const credentials = options.credentials;
  const systems = options.systems ?? null;
  const machineSettings = options.machineSettings ?? null;
  const asks = options.asks ?? null;
  const logins = options.logins ?? null;
  const installs = options.installs ?? null;
  const uploads = options.uploads ?? null;
  const roots = options.roots ?? [homedir()];
  const plugins = options.plugins ?? null;
  const maxChangedFiles = options.maxChangedFiles ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  // This socket is read-only, so any inbound message is a protocol violation; bound it at MAX_BODY_BYTES rather than the ws 100 MiB default.
  wss.options.maxPayload = MAX_BODY_BYTES;

  // Last resort, after every per-route mapping has declined: internal_error signals a missing mapping (not the catch-all Q1.50 refused).
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    // 500 is deliberately not in ErrorStatus: this is a failure to answer, not a refusal.
    return c.json(errorEnvelope("internal_error", describeError(error)), 500);
  });

  // gzip, then CORS, both before the auth gate: a preflight carries no credential, and a 401 without CORS headers is unreadable.
  app.use("*", gzipResponses());

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: [...CORS_ALLOW_METHODS],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      maxAge: CORS_MAX_AGE_SECONDS,
      credentials: false,
    }),
  );

  // After CORS so a 413 is readable cross-origin; before auth because an unauthenticated caller pushing bytes is the case this bounds.
  const boundedBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      jsonError(c, 413, "payload_too_large", `a request body may not exceed ${MAX_BODY_BYTES} bytes`, {
        limit: MAX_BODY_BYTES,
      }),
  });
  // Streaming routes skip the body bound, and their body is always cancelled afterwards: an unread body parks the relay stream and can close the machine's tunnel.
  app.use("*", async (c, next) => {
    if (!isStreamingRoute(c.req.method, c.req.path)) return boundedBody(c, next);
    try {
      await next();
    } finally {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null).catch(() => {
        // Nothing else to do: an unreadable answer would be worse than a parked sender.
      });
    }
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();

    const result = verifier.verify(readCredential(c));
    if (!result.ok) {
      const detail =
        result.skewMs === undefined
          ? null
          : { skewMs: result.skewMs, daemonTime: Date.now(), leewayMs: AUTH_LEEWAY_MS };
      return jsonError(c, 401, result.code, result.message, detail);
    }

    c.set("principal", result.principal);
    return next();
  });

  const sessionOf = (c: Context<AppEnv>): ManagedSession | undefined =>
    registry.get(c.req.param("id") ?? "");

  const git = registry.sessionRuntime.git();

  const requireScope =
    (scope: Scope): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (!hasScope(c.get("principal"), scope)) {
        return jsonError(c, 403, "insufficient_scope", `this token lacks the ${scope} scope`, {
          required: scope,
        });
      }
      return next();
    };
  const read = requireScope("session:read");
  const write = requireScope("session:write");
  const admin = requireScope("machine:admin");

  // A thunk, never captured: PluginHost replaces the catalogue on every install, update, remove and enable.
  const machineOf = () => registry.machineCatalogue;
  const offeredHarness = (id: string): boolean => machineOf().harnessState(id) === "enabled";

  let importing = false;

  const withSession =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, managed: ManagedSession) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    (c) => {
      const managed = sessionOf(c);
      if (!managed) return notFound(c);
      return handler(c, managed);
    };

  const requireJson = async (c: Context<AppEnv>): Promise<Record<string, unknown> | Response> =>
    (await readJsonObject(c)) ?? jsonError(c, 400, "bad_request", "expected a JSON object body");

  const requestedPath = async (
    c: Context<AppEnv>,
    managed: ManagedSession,
  ): Promise<{ rel: string; full: string } | Response> => {
    const requested = c.req.query("path");
    if (requested === undefined) return jsonError(c, 400, "bad_request", "path is required");
    const safe = safeRelPath(managed.workspace.root, requested);
    if (!safe.ok) {
      return jsonError(c, 400, "invalid_path", "that path is not inside this session's tree", {
        reason: safe.reason,
      });
    }
    // probeRequestable re-tests the resolved path, so a symlink cannot walk past the .git refusal in safeRelPath.
    const answer = await probeRequestable(managed.workspace.root, safe.full);
    if (answer === null) {
      return jsonError(c, 503, "path_unresponsive", "the filesystem holding that path did not answer", {
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
    }
    if (answer !== "ok") {
      return jsonError(c, 400, "invalid_path", "that path is not inside this session's tree", {
        reason: answer,
      });
    }
    return { rel: safe.rel, full: safe.full };
  };

  app.get("/health", (c) => {
    // Liveness only: this route is unauthenticated, so it exposes no per-session state.
    return c.json({
      ok: true,
      instanceId,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      shuttingDown: registry.isShuttingDown,
      time: Date.now(),
      authMode: verifier.mode,
      // Announced, not negotiated: nothing may branch on version; protocol is the one that carries capability.
      version: DAEMON_VERSION,
      protocol: RELAY_PROTOCOL_VERSION,
    });
  });

  // supported must stay equal to blocked being null; the no-store no_script folds in under the agent's own reason, never over no_flow.
  const loginSupportOf = (agent: AgentId): AgentLoginSupport => {
    const support = registry.sessionRuntime.loginSupport(agent);
    const blocked = support.blocked ?? (logins === null ? "no_script" : null);
    return {
      supported: blocked === null,
      blocked,
      needsInput: support.needsInput,
      canSignOut: support.canSignOut,
    };
  };

  const agentRowExtras = async (): Promise<
    (agent: { id: AgentId; installable?: boolean }) => Record<string, unknown>
  > => {
    const settingsMode = await claudeSettingsMode();
    return (agent) => ({
      login: loginSupportOf(agent.id),
      installable: agent.installable === true && installs !== null,
      ...(agent.id === "claude" && settingsMode !== null ? { settingsMode } : {}),
    });
  };

  app.get("/agents", read, async (c) => {
    const extras = await agentRowExtras();
    return c.json({
      agents: (await registry.sessionRuntime.availability()).map((agent) => ({
        ...agent,
        ...extras(agent),
      })),
    });
  });

  // No route here accepts a URL, header name or variable name: a request names a SystemId and a table resolves it.

  const systemIdParam = (c: Context<AppEnv>): SystemId | null => {
    const value = c.req.param("system") ?? "";
    return registry.machineCatalogue.systemState(value) === "enabled" ? value : null;
  };

  const noSuchSystem = (c: Context<AppEnv>): Response =>
    registry.machineCatalogue.systemState(c.req.param("system") ?? "") === "disabled"
      ? jsonError(
          c,
          503,
          "system_unavailable",
          "this provider comes from a plugin that is switched off on this machine",
        )
      : jsonError(c, 400, "invalid_system", "unknown system");

  app.get("/systems", read, (c) => {
    const machine = registry.machineCatalogue;
    const saved = new Map((systems?.credentials.list() ?? []).map((one) => [one.system, one]));
    return c.json({
      systems: machine.systemIds().flatMap((id) => {
        const spec = machine.system(id);
        if (spec === null) return [];
        const held = saved.get(id);
        return [{
          id,
          displayName: spec.displayName,
          apiType: spec.apiType,
          routable: spec.baseUrl !== null,
          nativeHarness: spec.nativeHarness,
          loginVia: spec.loginVia,
          models: spec.models,
          nativeModelPrefix: spec.nativeModelPrefix,
          keyEnv: spec.keyEnv,
          keySet:
            systemSecretFor(
              id,
              systems?.credentials.get(id) ?? null,
              (agent: AgentId) => credentials?.envFor(agent) ?? {},
              // The live catalogue, so this answers exactly what applySystem reads at start; defaulted, every plugin provider would read as keyless (Q3.485).
              machine,
            ) !== null,
          keyUpdatedAt: held?.updatedAt ?? null,
          ...(spec.contributedBy === undefined ? {} : { contributedBy: spec.contributedBy }),
        }];
      }),
    });
  });

  app.put("/systems/:system", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const system = systemIdParam(c);
    if (system === null) return noSuchSystem(c);
    const body = await readJsonObject(c);
    const token = body?.["token"];
    if (typeof token !== "string" || token.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "token is required and must be non-empty");
    }
    if (token.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `token exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }
    systems.credentials.save(system, token.trim());
    // No availability flush or restart: a system key is handed to providers/set at launch, never injected at spawn.
    return c.json({ saved: true, system });
  });

  app.delete("/systems/:system", write, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    // Removed before validation, so a row this build cannot resolve stays deletable (Q7.124).
    const named = c.req.param("system") ?? "";
    const system = systemIdParam(c);
    systems.credentials.remove(named as SystemId);
    // Presets naming this system are deliberately kept; starting one without a key refuses by name.
    return c.json({ removed: system !== null, system: named });
  });

  // Spawns one agent per harness, with no prompt; AgentAskRuns bounds and caches it. Per-harness failures are answered, never thrown.
  app.get("/agents/capabilities", read, async (c) => {
    if (asks === null) {
      return jsonError(c, 503, "model_unavailable", "this daemon cannot read agent capabilities");
    }
    // Asked all at once: the capability path queues for an ask slot, so the sweep cannot lose a race against its own bound.
    const machine = machineOf();
    const pinsModel = (id: string): boolean => routedModelNaming(id, machine) !== null;
    const entries = await Promise.all(
      machine.harnessIds().map(async (id): Promise<readonly [string, unknown]> => {
      try {
        const answer = await asks.capabilities(id, c.req.raw.signal, true);
        return [
          id,
          {
            models: answer.models,
            routing: answer.routing === null ? null : { ...answer.routing, pinsModel: pinsModel(id) },
            // Projected: the CLI's absolute path is deliberately not sent.
            cli: answer.cli === null ? null : { version: answer.cli.version, source: answer.cli.source },
            error: null,
          },
        ] as const;
      } catch (error) {
        return [
          id,
          { models: [], routing: null, cli: null, error: error instanceof Error ? error.message : String(error) },
        ] as const;
      }
      }),
    );
    return c.json({ agents: Object.fromEntries(entries) });
  });

  app.get("/custom-agents", read, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    return c.json({ customAgents: systems.customAgents.list() });
  });

  // Shared by create and edit so they cannot drift; an edit is a replace, so all four fields are required.
  const readAssembledAgent = async (
    c: Context<AppEnv>,
  ): Promise<Omit<CustomAgent, "id" | "createdAt"> | Response> => {
    const body = await readJsonObject(c);
    // Unknown is 400, switched off is 503: a stored preset can name a harness whose plugin was since disabled.
    const harness = body?.["harness"];
    if (typeof harness !== "string" || machineOf().harnessState(harness) === "unknown") {
      return jsonError(c, 400, "invalid_agent", "harness must be one this machine offers", {
        offers: machineOf().harnessIds(),
      });
    }
    if (!offeredHarness(harness)) {
      return jsonError(
        c,
        503,
        "harness_unavailable",
        "this agent comes from a plugin that is switched off on this machine",
      );
    }
    const system = body?.["system"];
    if (typeof system !== "string" || machineOf().systemState(system) === "unknown") {
      return jsonError(c, 400, "invalid_system", "system must be one this machine offers", {
        offers: machineOf().systemIds(),
      });
    }
    if (machineOf().systemState(system) !== "enabled") {
      return jsonError(
        c,
        503,
        "system_unavailable",
        "this provider comes from a plugin that is switched off on this machine",
      );
    }
    const model = body?.["model"];
    if (typeof model !== "string" || model.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "model is required and must be non-empty");
    }
    if (model.length > MAX_MODEL_CHARS) {
      return jsonError(c, 400, "bad_request", `model exceeds ${MAX_MODEL_CHARS} characters`);
    }
    const name = body?.["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "name is required and must be non-empty");
    }
    if (name.length > MAX_AGENT_NAME_CHARS) {
      return jsonError(c, 400, "bad_request", `name exceeds ${MAX_AGENT_NAME_CHARS} characters`);
    }
    // The pairing is refused here, not only in the picker, and routing is read from the harness itself.
    // A busy or failed read is 503, never routing null, which means the harness answered nothing.
    let routing: Awaited<ReturnType<AgentCapabilityReader["capabilities"]>>["routing"] = null;
    if (asks !== null) {
      try {
        routing = (await asks.capabilities(harness, AbortSignal.timeout(CAPABILITY_READ_BUDGET_MS)))
          .routing;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return jsonError(
          c,
          503,
          error instanceof AgentAskError ? error.code : "model_failed",
          `${harness} could not be asked what it can be pointed at right now: ${detail}`,
        );
      }
    }
    // The live catalogue: the default BUILTIN_CATALOGUE refuses every plugin pairing that would start (Q3.485).
    const refusal = hostable(harness, system, routing, machineOf());
    if (refusal !== null) {
      return jsonError(c, 400, "incompatible_pairing", refusal, { harness, system });
    }
    return { name: name.trim(), harness, system, model: model.trim() };
  };

  app.post("/custom-agents", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const draft = await readAssembledAgent(c);
    if (draft instanceof Response) return draft;
    // Minted against the store: save is an upsert, so a colliding id would silently overwrite a preset.
    let id = `ca_${randomBytes(4).toString("hex")}`;
    for (let attempt = 0; systems.customAgents.get(id) !== null; attempt += 1) {
      if (attempt >= 8) {
        return jsonError(c, 503, "systems_unavailable", "could not mint an id for this agent");
      }
      id = `ca_${randomBytes(4).toString("hex")}`;
    }
    const one = { id, ...draft, createdAt: Date.now() };
    systems.customAgents.save(one);
    return c.json({ customAgent: one }, 201);
  });

  // Every field required. A harness edit demotes existing sessions to the bare harness, see ManagedSession.assembled.
  app.patch("/custom-agents/:id", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const stored = systems.customAgents.get(c.req.param("id") ?? "");
    if (stored === null) {
      return jsonError(c, 404, "custom_agent_not_found", "no such agent");
    }
    const draft = await readAssembledAgent(c);
    if (draft instanceof Response) return draft;
    // Looked up again: the capability read above takes seconds, and the upsert would resurrect a row deleted meanwhile.
    if (systems.customAgents.get(stored.id) === null) {
      return jsonError(c, 404, "custom_agent_not_found", "no such agent");
    }
    const one = { id: stored.id, ...draft, createdAt: stored.createdAt };
    systems.customAgents.save(one);
    return c.json({ customAgent: one });
  });

  // An unknown id is 200 removed false, never 404: the transport replays DELETE.
  // The remove runs either way, so a row this build cannot parse stays deletable.
  app.delete("/custom-agents/:id", write, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const id = c.req.param("id") ?? "";
    const removed = systems.customAgents.get(id) !== null;
    systems.customAgents.remove(id);
    systems.strip.forget("custom", id);
    return c.json({ removed, id });
  });

  // The strip is stored and returned as sent; which refs still name something is the client's decision.

  // A saved value overrides REEMOAT_IDLE_PARK_MINUTES, which is only the default (Q2.225).
  app.get("/settings", read, (c) => {
    return c.json({ settings: registry.machineSettings() });
  });

  app.patch("/settings", write, async (c) => {
    if (machineSettings === null) {
      return jsonError(c, 503, "settings_unavailable", "this daemon has no durable store for settings");
    }
    const body = await requireJson(c);
    if (body instanceof Response) return body;

    // The whole body is validated before any key is written, so a refusal changes nothing.
    const wanted: [MachineSettingKey, string][] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!isMachineSettingKey(key)) {
        return jsonError(c, 400, "unknown_setting", `this daemon has no setting called "${key}"`);
      }
      const refusal = MACHINE_SETTING_RULES[key](value);
      if (refusal !== null) return jsonError(c, 400, "invalid_setting", refusal);
      wanted.push([key, String(value)]);
    }
    for (const [key, value] of wanted) machineSettings.write(key, value);
    registry.applyMachineSettings();
    return c.json({ saved: true, settings: registry.machineSettings() });
  });

  app.get("/agent-strip", read, (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    return c.json({ entries: systems.strip.list() });
  });

  // PUT replaces the whole list. Duplicates are refused here rather than as a primary-key 500; refs are never validated.
  const readStripEntries = async (c: Context<AppEnv>): Promise<AgentStripEntry[] | Response> => {
    const body = await readJsonObject(c);
    if (body === null) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const raw = body["entries"];
    if (!Array.isArray(raw)) return jsonError(c, 400, "bad_request", "entries must be an array");
    if (raw.length > MAX_STRIP_ENTRIES) {
      return jsonError(c, 400, "bad_request", `entries exceeds ${MAX_STRIP_ENTRIES} items`);
    }
    const entries: AgentStripEntry[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return jsonError(c, 400, "bad_request", "each entry must be an object");
      }
      const one = item as Record<string, unknown>;
      const kind = one["kind"];
      if (kind !== "harness" && kind !== "custom") {
        return jsonError(c, 400, "bad_request", 'kind must be "harness" or "custom"');
      }
      const ref = one["ref"];
      if (typeof ref !== "string" || ref.length === 0) {
        return jsonError(c, 400, "bad_request", "ref must be a non-empty string");
      }
      if (ref.length > MAX_STRIP_REF_CHARS) {
        return jsonError(c, 400, "bad_request", `ref exceeds ${MAX_STRIP_REF_CHARS} characters`);
      }
      const hidden = one["hidden"];
      if (typeof hidden !== "boolean") {
        return jsonError(c, 400, "bad_request", "hidden must be a boolean");
      }
      const key = `${kind}:${ref}`;
      if (seen.has(key)) {
        return jsonError(c, 400, "bad_request", `entries names ${key} twice`);
      }
      seen.add(key);
      entries.push({ kind, ref, hidden });
    }
    return entries;
  };

  app.put("/agent-strip", write, async (c) => {
    if (systems === null) {
      return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
    }
    const entries = await readStripEntries(c);
    if (entries instanceof Response) return entries;
    systems.strip.replace(entries);
    return c.json({ saved: true, entries: systems.strip.list() });
  });

  const agentIdParam = (c: Context<AppEnv>): AgentId | null => {
    const value = c.req.param("agent") ?? "";
    return registry.machineCatalogue.harnessState(value) === "enabled" ? value : null;
  };

  // Switched off is 503 naming the switch, never the 400 that blames the caller.
  const noSuchHarness = (c: Context<AppEnv>): Response =>
    registry.machineCatalogue.harnessState(c.req.param("agent") ?? "") === "disabled"
      ? jsonError(
          c,
          503,
          "harness_unavailable",
          "this agent comes from a plugin that is switched off on this machine",
        )
      : jsonError(c, 400, "invalid_agent", "unknown agent");

  app.get("/agent-auth", read, async (c) => {
    const availability = await registry.sessionRuntime.availability();
    const stored = credentials?.list() ?? [];
    return c.json({
      // Both halves: somewhere to record a run, and a host that can allocate a pty.
      loginSupported: logins !== null && registry.sessionRuntime.loginSupported,
      os: process.platform,
      agents: availability.map((agent) => {
        return {
          ...agent,
          credentials: registry.sessionRuntime.credentialSlots(agent.id).map((envName) => {
            const row = stored.find(
              (entry) => entry.agent === agent.id && entry.envName === envName,
            );
            // The secret is never in this response.
            return { envName, set: row !== undefined, updatedAt: row?.updatedAt ?? null };
          }),
          login: loginSupportOf(agent.id),
        };
      }),
    });
  });

  app.put("/agent-auth/:agent", write, async (c) => {
    if (credentials === undefined) {
      return jsonError(c, 503, "credentials_unavailable", "this daemon has no durable store for credentials");
    }
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);

    const body = await readJsonObject(c);
    const envName = body?.["envName"];
    const token = body?.["token"];
    if (typeof envName !== "string" || !registry.sessionRuntime.credentialSlots(agent).includes(envName)) {
      return jsonError(c, 400, "bad_request", "envName must be one this agent reads", {
        envNames: registry.sessionRuntime.credentialSlots(agent),
      });
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "token is required and must be non-empty");
    }
    if (token.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `token exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }

    credentials.save(agent, envName, token.trim());
    registry.sessionRuntime.forgetAvailability();
    // Only a credential arriving clears the refused start; sign-out-ward events must not.
    registry.sessionRuntime.forgetStartRefusal(agent);
    // Secrets are injected at spawn, so running sessions on this agent are restarted to pick the token up.
    const restarting = registry.reloadCredentials(agent);
    return c.json({ saved: true, agent, envName, restarting });
  });

  app.delete("/agent-auth/:agent", write, (c) => {
    if (credentials === undefined) {
      return jsonError(c, 503, "credentials_unavailable", "this daemon has no durable store for credentials");
    }
    // Removes before validating and answers what the lookup saw, so a switched-off plugin's key stays deletable.
    const named = c.req.param("agent") ?? "";
    const envName = c.req.query("envName") ?? "";
    if (named.length === 0 || envName.length === 0) {
      return jsonError(c, 400, "bad_request", "envName is required");
    }
    const agent = agentIdParam(c);
    if (agent !== null && !registry.sessionRuntime.credentialSlots(agent).includes(envName)) {
      return jsonError(c, 400, "bad_request", "envName must be one this agent reads", {
        envNames: registry.sessionRuntime.credentialSlots(agent),
      });
    }
    const had = credentials.list().some((one) => one.agent === named && one.envName === envName);
    credentials.remove(named, envName);
    registry.sessionRuntime.forgetAvailability();
    // Not revived: removing a credential is a sign-out's second half, never its reversal.
    const restarting = registry.reloadCredentials(named, false);
    return c.json({ removed: had, agent: named, envName, restarting });
  });

  // Clears our stored credential first, so it stays cleared if the CLI logout fails; the 502 says which half happened.
  app.post("/agent-auth/:agent/logout", write, async (c) => {
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);
    if (!registry.sessionRuntime.loginSupport(agent).canSignOut) {
      return jsonError(
        c,
        503,
        "logout_unsupported",
        `${agent} has no sign-out command; remove its credentials on that machine by hand`,
      );
    }

    let cleared = 0;
    for (const envName of registry.sessionRuntime.credentialSlots(agent)) {
      if (credentials?.list().some((row) => row.agent === agent && row.envName === envName) === true) {
        credentials.remove(agent, envName);
        cleared += 1;
      }
    }

    const result = await registry.sessionRuntime.logout(agent);
    registry.sessionRuntime.forgetAvailability();
    if (result === null) {
      return jsonError(c, 503, "logout_unsupported", `${agent} has no sign-out command`);
    }
    if (!result.ok) return jsonError(c, 502, "logout_failed", result.detail ?? "the CLI refused");
    // Awaited: signing out is a request to stop, and the answer must not precede it.
    const ended = await registry.signOutSessions(agent);
    return c.json({
      signedOut: true,
      agent,
      credentialsCleared: cleared,
      sessionsEnded: ended,
      detail: result.detail,
    });
  });

  // Must answer for harnesses with no login or logout verb. Under /agent-auth so the client's slowRoute prefix gives it the long budget.
  app.post("/agent-auth/:agent/recheck", write, async (c) => {
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);
    registry.sessionRuntime.forgetStartRefusal(agent);
    registry.sessionRuntime.forgetAvailability();
    const found = (await registry.sessionRuntime.availability()).find((one) => one.id === agent) ?? null;
    const extras = await agentRowExtras();
    return c.json({
      agent,
      ...(found === null ? { rechecked: false } : { rechecked: true, info: { ...found, ...extras(found) } }),
    });
  });

  app.post("/agent-auth/:agent/login", write, async (c) => {
    if (logins === null) {
      return jsonError(
        c,
        503,
        "login_unsupported",
        "this daemon's runtime will not drive an agent login; paste a token instead",
      );
    }
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);

    try {
      const run = await logins.start(agent);
      if (run === null) {
        return jsonError(c, 503, "login_unsupported", "this daemon's runtime will not drive an agent login");
      }
      return c.json(run, 201);
    } catch (error) {
      const message = describeError(error);
      return jsonError(c, 502, "login_failed", message);
    }
  });

  app.get("/agent-auth/login/:loginId", read, (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const since = Number(c.req.query("since") ?? 0);
    const chunk = logins.read(c.req.param("loginId"), Number.isFinite(since) ? since : 0);
    // A superseded run's id no longer resolves, so a stale wizard cannot read its successor's one-time code.
    if (chunk === null) return jsonError(c, 404, "login_not_found", "no such login");
    if (chunk.done) {
      registry.sessionRuntime.forgetAvailability();
      // A finished sign-in is a credential arriving, so it clears the refused start; kept, start_refused outranks signed_in once signInOffered has gone false.
      // Cleared on the run ending, not on its success.
      registry.sessionRuntime.forgetStartRefusal(chunk.agent);
    }
    return c.json(chunk);
  });

  app.post("/agent-auth/login/:loginId/input", write, async (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const body = await readJsonObject(c);
    const text = body?.["text"];
    if (typeof text !== "string") {
      return jsonError(c, 400, "bad_request", "text is required");
    }
    if (text.length > MAX_CREDENTIAL_CHARS) {
      return jsonError(c, 400, "bad_request", `text exceeds ${MAX_CREDENTIAL_CHARS} characters`);
    }
    // HTTP rather than the stream: a login code is sent once and needs a confirmed delivery.
    const result = logins.write(c.req.param("loginId"), text);
    if (result.kind === "not_found") return jsonError(c, 404, "login_not_found", "no such login");
    if (result.kind === "not_interactive") {
      return jsonError(
        c,
        400,
        "login_not_interactive",
        "this login reads no input; finish it on the page it printed",
      );
    }
    return c.json(result.view);
  });

  app.delete("/agent-auth/login/:loginId", write, async (c) => {
    if (logins === null) return jsonError(c, 404, "login_not_found", "no such login");
    const cancelled = await logins.cancel(c.req.param("loginId"));
    if (!cancelled) return jsonError(c, 404, "login_not_found", "no such login");
    registry.sessionRuntime.forgetAvailability();
    return c.json({ cancelled: true });
  });

  // Installing a harness: machine:admin on the writes, read on the poll; every handler answers in milliseconds.

  app.get("/agent-install", read, (c) =>
    c.json({ supported: installs !== null, run: installs?.live() ?? null }),
  );

  // Built-in harnesses only: deploy/agents.sh knows its own five names and nothing a plugin added.
  app.post("/agent-install/:agent", admin, (c) => {
    if (installs === null) {
      return jsonError(
        c,
        503,
        "install_unsupported",
        "this daemon will not install agents; run deploy/agents.sh on this machine instead",
      );
    }
    const agent = agentIdParam(c);
    if (agent === null) return noSuchHarness(c);
    if (!isBuiltinAgentId(agent)) {
      return jsonError(
        c,
        503,
        "harness_not_installable",
        `${agent} was added by a plugin, and this daemon installs only the harnesses it ships; ` +
          `put it on this machine the way that plugin documents`,
      );
    }
    const started = installs.start(agent);
    if (started.kind === "busy") {
      return jsonError(
        c,
        409,
        "install_busy",
        started.holder.kind === "update"
          ? "this machine is refreshing its agents; try again in a moment"
          : `this machine is installing ${started.holder.agent ?? "an agent"}; try again when it finishes`,
        started.holder,
      );
    }
    if (started.kind === "spawn_failed") {
      return jsonError(c, 502, "install_failed", started.detail);
    }
    return c.json(started.view, 201);
  });

  app.get("/agent-install/runs/:installId", read, (c) => {
    if (installs === null) return jsonError(c, 404, "install_not_found", "no such install");
    const since = Number.parseInt(c.req.query("since") ?? "0", 10);
    const chunk = installs.read(c.req.param("installId"), Number.isFinite(since) ? since : 0);
    if (chunk === null) return jsonError(c, 404, "install_not_found", "no such install");
    return c.json(chunk);
  });

  app.delete("/agent-install/runs/:installId", admin, (c) => {
    if (installs === null) return jsonError(c, 404, "install_not_found", "no such install");
    if (!installs.cancel(c.req.param("installId"))) {
      return jsonError(c, 404, "install_not_found", "no such install");
    }
    return c.json({ cancelled: true });
  });

  app.get("/fs/roots", read, (c) =>
    c.json({
      roots,
      recent: registry.recentCwds(),
    }),
  );

  app.post("/fs/mkdir", write, async (c) => {
    const body = await readJsonObject(c);
    const parent = body?.["parent"];
    const name = body?.["name"];
    if (typeof parent !== "string" || typeof name !== "string") {
      return jsonError(c, 400, "bad_request", "parent and name are both required");
    }
    if (name.length > MAX_DIR_NAME_CHARS) {
      return jsonError(c, 400, "bad_request", `name exceeds ${MAX_DIR_NAME_CHARS} characters`);
    }
    if (parent.length > MAX_PATH_CHARS) {
      return jsonError(c, 400, "bad_request", `parent exceeds ${MAX_PATH_CHARS} characters`);
    }
    try {
      return c.json({ path: await makeDir(parent, name) }, 201);
    } catch (error) {
      if (error instanceof PathError) {
        return jsonError(c, pathErrorStatus(error, 400), error.code, error.message);
      }
      const errno = errnoError(c, error, 400);
      if (errno) return errno;
      throw error;
    }
  });

  app.post("/fs/import", write, async (c) => {
    const refuse = async <T>(answer: () => T): Promise<T> => {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
      return answer();
    };

    if (registry.isShuttingDown) {
      return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
    }

    const path = c.req.query("path") ?? "";
    if (path.length === 0) return refuse(() => jsonError(c, 400, "bad_request", "path is required"));
    if (path.length > MAX_PATH_CHARS) {
      return refuse(() => jsonError(c, 400, "bad_request", `path exceeds ${MAX_PATH_CHARS} characters`));
    }

    const requested = c.req.query("name") ?? "";
    const named = sanitizeUploadName(requested);
    if (!named.ok) {
      return refuse(() =>
        jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
      );
    }

    // Content-length is honoured to refuse, never to accept.
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      return refuse(() =>
        jsonError(c, 413, "import_too_large", `an archive may not exceed ${MAX_IMPORT_BYTES} bytes`, {
          limit: MAX_IMPORT_BYTES,
          declared,
        }),
      );
    }

    // One import at a time daemon-wide: nothing here is charged against a budget, so the bound is arrival.
    if (importing) {
      return refuse(() =>
        jsonError(c, 409, "import_busy", "this machine is already unpacking an import"),
      );
    }

    // Claimed before the first await: nothing between the test and the set may suspend.
    importing = true;
    try {
      let target: string;
      try {
        target = await resolveCwd(path);
      } catch (error) {
        if (error instanceof PathError) {
          return refuse(() => jsonError(c, pathErrorStatus(error, 400), error.code, error.message));
        }
        const errno = errnoError(c, error, 400);
        if (errno) return refuse(() => errno);
        await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
        throw error;
      }

      const body = c.req.raw.body;
      if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

      const outcome: ImportOutcome = await importArchive({ target, name: named.name, body });

      switch (outcome.kind) {
        case "ok":
          return c.json({ import: outcome.result }, 201);
        case "too_large":
          return jsonError(c, 413, "import_too_large", `an archive may not exceed ${MAX_IMPORT_BYTES} bytes`, {
            limit: MAX_IMPORT_BYTES,
          });
        case "unsupported":
          return jsonError(c, 400, "unsupported_archive", "that is not a .zip or a .tar.gz");
        case "exists":
          return jsonError(c, 409, "import_exists", `${outcome.name} is already here`, { name: outcome.name });
        case "refused": {
          const { error } = outcome;
          if (error.code === "too_large") {
            return jsonError(c, 413, "import_unpacked_too_large", error.message, {
              limit: MAX_IMPORT_UNPACKED_BYTES,
            });
          }
          if (error.code === "too_many") {
            return jsonError(c, 413, "import_too_many_entries", error.message, { limit: MAX_IMPORT_ENTRIES });
          }
          if (error.code === "unsafe") {
            return jsonError(c, 400, "archive_unsafe", error.message, error.refusal);
          }
          if (error.code === "empty") return jsonError(c, 400, "archive_empty", error.message);
          return jsonError(c, 400, "archive_unreadable", error.message);
        }
        case "write_failed":
          return jsonError(c, 503, "import_write_failed", "could not unpack that here", {
            detail: outcome.detail,
          });
      }
    } finally {
      importing = false;
    }
  });

  app.get("/fs/list", read, async (c) => {
    const path = c.req.query("path") ?? null;
    const showHidden = c.req.query("hidden") === "1";
    try {
      return c.json(await listDirs(path, { roots, showHidden }));
    } catch (error) {
      if (error instanceof PathError) {
        return jsonError(c, pathErrorStatus(error, 404), error.code, error.message);
      }
      const errno = errnoError(c, error, 404);
      if (errno) return errno;
      throw error;
    }
  });

  app.post("/sessions", write, async (c) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }
    const body = await requireJson(c);
    if (body instanceof Response) return body;

    let customAgent: string | null = null;
    let agent: string | undefined;
    const namedPreset = body["customAgent"];
    if (namedPreset !== undefined && namedPreset !== null) {
      if (typeof namedPreset !== "string" || namedPreset.length === 0) {
        return jsonError(c, 400, "bad_request", "customAgent must be a non-empty string");
      }
      if (systems === null) {
        return jsonError(c, 503, "systems_unavailable", "this daemon has no durable store for systems");
      }
      const preset = systems.customAgents.get(namedPreset);
      // custom_agent_not_found, because not_found already means a missing cwd on this route.
      if (preset === null) {
        return jsonError(c, 404, "custom_agent_not_found", "no such agent");
      }
      customAgent = preset.id;
      agent = preset.harness;
      // A preset's system is weighed before any worktree is made: an applySystem failure lands after it.
      if (machineOf().systemState(preset.system) !== "enabled") {
        return jsonError(
          c,
          machineOf().systemState(preset.system) === "disabled" ? 503 : 400,
          machineOf().systemState(preset.system) === "disabled"
            ? "system_unavailable"
            : "invalid_system",
          machineOf().systemState(preset.system) === "disabled"
            ? "this agent is assembled on a provider that comes from a plugin switched off on this machine"
            : "this agent is assembled on a provider this machine no longer offers",
          { system: preset.system },
        );
      }
    } else {
      const named = body["agent"];
      agent = typeof named === "string" ? named : undefined;
    }
    if (typeof agent !== "string" || machineOf().harnessState(agent) === "unknown") {
      return jsonError(c, 400, "invalid_agent", "agent must be one this machine offers", {
        offers: machineOf().harnessIds(),
      });
    }
    if (machineOf().harnessState(agent) === "disabled") {
      return jsonError(
        c,
        503,
        "harness_unavailable",
        "this agent comes from a plugin that is switched off on this machine",
      );
    }
    const cwd = body["cwd"];
    if (typeof cwd !== "string" || cwd.length === 0) {
      return jsonError(c, 400, "bad_request", "cwd is required");
    }

    const raw = body["worktree"];
    let worktree: WorktreePolicy | undefined;
    if (raw === true) worktree = "require";
    else if (raw === false) worktree = "never";
    else if (raw === "auto" || raw === "require" || raw === "never") worktree = raw;
    else if (raw !== undefined) {
      return jsonError(c, 400, "bad_request", 'worktree must be true, false, "auto", "require" or "never"');
    }

    const branchRaw = body["branch"];
    if (branchRaw !== undefined && (typeof branchRaw !== "string" || branchRaw.length === 0 || branchRaw.length > 200)) {
      return jsonError(c, 400, "bad_request", "branch must be a non-empty string of at most 200 characters");
    }
    const branch = typeof branchRaw === "string" ? branchRaw : null;

    try {
      const managed = await registry.create({ agent, customAgent, cwd, worktree, branch });
      return c.json({ session: managed.snapshot() }, 201);
    } catch (error) {
      if (error instanceof PathError) {
        return jsonError(c, pathErrorStatus(error, 400), error.code, error.message);
      }
      if (error instanceof WorktreeError) {
        return worktreeError(c, error);
      }
      if (error instanceof SystemRoutingError) {
        return jsonError(c, 502, "system_not_routable", error.message);
      }
      if (error instanceof SessionLimitError) {
        // retryAfterSeconds rides the detail: clients parse the body, never the headers.
        return jsonError(c, 429, error.reason, error.message, {
          retryAfterSeconds: error.retryAfterSeconds,
        });
      }
      if (error instanceof AgentUnavailableError) {
        return jsonError(c, 503, "agent_unavailable", error.message);
      }
      if (error instanceof StartTimeoutError) {
        return jsonError(c, 504, "agent_start_timeout", error.message, {
          sessionId: error.sessionId,
          timeoutMs: error.timeoutMs,
        });
      }
      const message = describeError(error);
      // Through isAuthRequiredMessage, so a remembered refusal gets the same code as the first.
      const code = isAuthRequiredMessage(message) ? "agent_auth_required" : "agent_launch_failed";
      return jsonError(c, 502, code, message);
    }
  });

  // With a limit, rows are ranked by listRank so a cut only drops what nobody waits on; total and truncated are always present.
  app.get("/sessions", read, (c) => {
    const all = registry.list().map((session) => session.snapshot({ listing: true }));
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? null : Math.max(0, boundedInt(limitParam, 0));

    if (limit === null) {
      return c.json({ sessions: all, total: all.length, truncated: false, now: Date.now(), instanceId });
    }

    const ranked = [...all].sort((a, b) => listRank(a) - listRank(b) || b.createdAt - a.createdAt);
    const sessions = ranked.slice(0, limit);
    return c.json({
      sessions,
      total: all.length,
      truncated: sessions.length < all.length,
      now: Date.now(),
      instanceId,
    });
  });

  app.get("/sessions/:id", read, withSession((c, managed) => {
    return c.json({ session: managed.snapshot({ fullConfig: true }) });
  }));

  app.delete("/sessions/:id", write, withSession(async (c, managed) => {
    await managed.stop("stopped");
    return c.json({ session: managed.snapshot() });
  }));

  app.post("/sessions/:id/resume", write, withSession(async (c, managed) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }

    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    try {
      await managed.resume();
      return c.json({ resumed: true, session: managed.snapshot() });
    } catch (error) {
      const failure = describeResumeFailure(error);
      const detail: Record<string, unknown> =
        error instanceof StartTimeoutError
          ? { sessionId: error.sessionId, timeoutMs: error.timeoutMs }
          : failure.status === 409
            ? { status: managed.status }
            : { session: managed.snapshot() };
      return jsonError(c, failure.status, failure.code, failure.message, detail);
    }
  }));

  app.post("/sessions/:id/prompt", write, withSession(async (c, managed) => {
    if (registry.isShuttingDown) {
      return jsonError(c, 503, "shutting_down", "the daemon is shutting down");
    }

    const body = await readJsonObject(c);
    const attachments = body?.["attachments"];
    const ids: string[] = [];
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        return jsonError(c, 400, "bad_request", "attachments must be an array of upload ids");
      }
      if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
        return jsonError(c, 400, "too_many_attachments", `at most ${MAX_PROMPT_ATTACHMENTS} files per message`, {
          limit: MAX_PROMPT_ATTACHMENTS,
        });
      }
      for (const id of attachments) {
        if (typeof id !== "string" || id.length === 0 || id.length > 64) {
          return jsonError(c, 400, "bad_request", "each attachment must be a non-empty upload id");
        }
        ids.push(id);
      }
    }

    let staged: UploadRow[] = [];
    if (ids.length > 0) {
      if (!uploads) return jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store");
      // Keyed on session and id, so another session's upload is missing rather than forbidden.
      const found = uploads.resolve(managed.id, ids);
      if (!found.ok) {
        return jsonError(c, 400, "unknown_attachment", "no such upload on this session", {
          uploadId: found.missing,
        });
      }
      staged = found.rows;
    }

    // Text is required unless files came with it; the client must not invent text for a file-only message.
    const text = body?.["text"];
    if (typeof text !== "string") {
      return jsonError(c, 400, "bad_request", "text must be a string");
    }
    if (text.trim().length === 0 && staged.length === 0) {
      return jsonError(c, 400, "bad_request", "send some text, a file, or both");
    }
    if (text.length > MAX_PROMPT_CHARS) {
      return jsonError(c, 400, "bad_request", `text exceeds ${MAX_PROMPT_CHARS} characters`);
    }

    // A restart this daemon started is waited out rather than answered turn_in_flight, and first, so everything below reads a settled session.
    // Deliberately no signed-in probe: signOutSessions and the pump's isAuthFailure cover both cases (Q7.99).
    await managed.whenRestarted();

    // The workspace is checked on every message: a folder deleted while open otherwise surfaces as an agent's internal error.
    const workspace = await workspaceReady(c, managed);
    if (workspace) return workspace;

    await registry.wakeForPrompt(managed);

    // /clear is carried out here, not forwarded: claude forks underneath ACP and never reports the new id. Exact match only.
    if (text.trim() === "/clear" && staged.length === 0) {
      const cleared = await managed.clearContext(text.trim());
      switch (cleared.kind) {
        case "cleared":
          return c.json({ accepted: true, cleared: true, seq: cleared.seq, session: managed.snapshot() }, 202);
        case "busy":
          return jsonError(c, 409, "turn_in_flight", "a turn is already in flight", {
            status: cleared.status,
            pendingPermissions: managed.snapshot().pendingPermissions,
            pendingElicitations: managed.snapshot().pendingElicitations,
          });
        case "not_ready":
          return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
            status: cleared.status,
          });
        case "terminal":
          return jsonError(c, 409, "session_terminal", "this session has ended", {
            status: cleared.status,
            exit: cleared.exit,
          });
      }
    }

    const result = managed.prompt(text, staged);
    switch (result.kind) {
      case "accepted":
        return c.json({ accepted: true, turn: result.turn, seq: result.seq, session: managed.snapshot() }, 202);
      // A running turn is not a refusal: sendMidTurn steers or queues, both a 202 carrying the seq.
      case "turn_in_flight": {
        const mid = await managed.sendMidTurn(text, staged);
        switch (mid.kind) {
          case "steered":
            return c.json(
              { accepted: true, steered: true, turn: mid.turn, seq: mid.seq, session: managed.snapshot() },
              202,
            );
          case "queued":
            return c.json(
              {
                accepted: true,
                queued: true,
                id: mid.id,
                seq: mid.seq,
                position: mid.position,
                session: managed.snapshot(),
              },
              202,
            );
          case "accepted":
            return c.json({ accepted: true, turn: mid.turn, seq: mid.seq, session: managed.snapshot() }, 202);
          case "queue_full":
            return jsonError(c, 429, "prompt_queue_full", "too many messages are already waiting or in flight for this session", {
              limit: mid.limit,
            });
          case "busy":
            return jsonError(c, 409, "session_busy", "this session's context is being cleared", {
              status: mid.status,
            });
          case "not_ready":
            return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
              status: mid.status,
            });
          case "terminal":
            return jsonError(c, 409, "session_terminal", "this session has ended", {
              status: mid.status,
              exit: mid.exit,
            });
        }
        break;
      }
      case "busy":
        // The code stays turn_in_flight: deployed clients read it and daemoncheck pins it.
        return jsonError(c, 409, "turn_in_flight", "a turn is already in flight", {
          status: result.status,
          pendingPermissions: managed.snapshot().pendingPermissions,
          pendingElicitations: managed.snapshot().pendingElicitations,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", {
          status: result.status,
          exit: result.exit,
        });
    }
  }));

  // No body is read. no_turn is a 200 with cancelled false, a lost race; terminal and not_ready stay 409.
  app.post("/sessions/:id/cancel", write, withSession(async (c, managed) => {
    const result = await managed.cancelTurn();
    switch (result.kind) {
      case "cancelled":
        return c.json({
          cancelled: true,
          turn: result.turn,
          settled: result.settled,
          session: managed.snapshot(),
        });
      case "no_turn":
        return c.json({ cancelled: false, turn: null, settled: true, session: managed.snapshot() });
      case "busy":
        return jsonError(c, 409, "session_busy", "this session's context is being cleared", {
          status: result.status,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", {
          status: result.status,
          exit: result.exit,
        });
    }
  }));

  // The task id is looked up in the set this session announced. stopped false is a 200, a lost race; 404 only for an id never announced.
  app.post("/sessions/:id/async-tasks/:taskId/stop", write, withSession(async (c, managed) => {
    const result = await managed.stopBackgroundTask(c.req.param("taskId"));
    switch (result.kind) {
      case "answered":
        return c.json({ stopped: result.stopped, session: managed.snapshot() });
      case "no_task":
        return jsonError(c, 404, "task_not_found", "this session has no such background task");
      case "failed":
        return jsonError(c, 502, "agent_error", `the agent could not stop it: ${result.detail}`);
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", {
          status: result.status,
          exit: result.exit,
        });
    }
  }));

  // The filename rides the name query parameter: CORS_ALLOW_HEADERS is shared with the relay and admits no new header. A terminal session still accepts uploads.
  app.post("/sessions/:id/uploads", write, async (c) => {
    const refuse = async <T>(answer: () => T): Promise<T> => {
      await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
      return answer();
    };

    const managed = sessionOf(c);
    if (!managed) return refuse(() => notFound(c));
    if (registry.isShuttingDown) {
      return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
    }
    if (!uploads) {
      return refuse(() => jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store"));
    }

    const requested = c.req.query("name") ?? "";
    const named = sanitizeUploadName(requested);
    if (!named.ok) {
      return refuse(() =>
        jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
      );
    }

    const mime = parseMime(c.req.header("content-type"));
    if (mime === undefined) {
      return refuse(() => jsonError(c, 400, "invalid_mime", "content-type must be type/subtype"));
    }

    // Honoured to refuse, never to accept: the Uploads.receive counter bounds the body, and the header keeps an honest 413 over the relay.
    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return refuse(() =>
        jsonError(c, 413, "upload_too_large", `a file may not exceed ${MAX_UPLOAD_BYTES} bytes`, {
          limit: MAX_UPLOAD_BYTES,
          declared,
        }),
      );
    }

    const body = c.req.raw.body;
    if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

    const result = await uploads.receive(managed.id, {
      name: named.name,
      origName: requested,
      mime,
      body: body as ReadableStream<Uint8Array>,
    });

    switch (result.kind) {
      case "ok":
        return c.json(
          {
            upload: {
              uploadId: result.row.uploadId,
              name: result.row.name,
              originalName: result.row.origName,
              mime: result.row.mime,
              bytes: result.row.bytes,
              createdAt: result.row.createdAt,
              sessionBytes: result.sessionBytes,
              sessionLimit: MAX_SESSION_UPLOAD_BYTES,
              sessionCount: result.sessionCount,
              countLimit: MAX_UPLOADS_PER_SESSION,
            },
          },
          201,
        );
      case "too_large":
        return jsonError(c, 413, "upload_too_large", `a file may not exceed ${MAX_UPLOAD_BYTES} bytes`, {
          limit: MAX_UPLOAD_BYTES,
        });
      case "quota":
        return jsonError(c, 413, "upload_quota_exceeded", "this session has no room for that file", {
          limit: MAX_SESSION_UPLOAD_BYTES,
          used: result.used,
        });
      case "too_many":
        return jsonError(c, 409, "upload_limit", "this session already holds too many staged files", {
          limit: MAX_UPLOADS_PER_SESSION,
        });
      case "rate": {
        const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        c.header("Retry-After", String(seconds));
        return jsonError(
          c,
          429,
          "upload_rate_limited",
          `too much has been uploaded to this session lately — try again in ${seconds}s`,
          { limit: UPLOAD_RATE_BYTES, windowMs: UPLOAD_RATE_WINDOW_MS, retryAfterMs: result.retryAfterMs },
        );
      }
      case "write_failed":
        return jsonError(c, 503, "upload_write_failed", "that file could not be stored", {
          detail: result.detail,
        });
    }
  });

  app.post("/sessions/:id/config", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;

    const modeId = body["modeId"];
    const configId = body["configId"];
    const hasMode = modeId !== undefined;
    const hasOption = configId !== undefined;
    if (hasMode === hasOption) {
      return jsonError(c, 400, "bad_request", 'body must carry exactly one of {"modeId"} or {"configId","value"}');
    }

    let result;
    try {
      if (hasMode) {
        if (typeof modeId !== "string" || modeId.length === 0) {
          return jsonError(c, 400, "bad_request", "modeId must be a non-empty string");
        }
        result = await managed.setMode(modeId);
      } else {
        const value = body["value"];
        if (typeof configId !== "string" || configId.length === 0) {
          return jsonError(c, 400, "bad_request", "configId must be a non-empty string");
        }
        if (typeof value !== "string" && typeof value !== "boolean") {
          return jsonError(c, 400, "bad_request", "value must be a string or a boolean");
        }
        result = await managed.setConfigOption(configId, value);
      }
    } catch (error) {
      const message = describeError(error);
      return jsonError(c, 502, "agent_config_failed", message, { session: managed.snapshot() });
    }

    switch (result.kind) {
      case "ok":
        return c.json({ config: result.config, session: managed.snapshot() });
      case "unknown_option":
        return jsonError(c, 400, "unknown_config_option", "this agent does not offer that option", {
          options: result.options,
        });
      case "invalid_value":
        return jsonError(c, 400, "invalid_config_value", "the agent does not offer that value for this option", {
          option: result.option,
        });
      case "unknown_mode":
        return jsonError(c, 400, "unknown_mode", "this agent does not offer that mode", {
          modes: result.modes,
        });
      case "busy":
        // session_busy, not turn_in_flight: a clear runs no turn, so nothing would ever end one.
        return jsonError(c, 409, "session_busy", "this session's context is being cleared", {
          status: result.status,
        });
      case "turn_in_flight":
        return jsonError(c, 409, "turn_in_flight", "this change restarts the agent; the turn must end first", {
          status: result.status,
        });
      case "not_ready":
        return jsonError(c, 409, "session_not_ready", "the agent has not finished starting", {
          status: result.status,
        });
      case "terminal":
        return jsonError(c, 409, "session_terminal", "this session has ended", { status: result.status });
    }
  }));

  app.post("/sessions/:id/meta", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;

    const change: { title?: string | null; pinned?: boolean; rank?: number | null } = {};

    if ("title" in body) {
      const title = body["title"];
      if (title !== null && typeof title !== "string") {
        return jsonError(c, 400, "bad_request", "title must be a string or null");
      }
      if (typeof title === "string" && title.length > MAX_TITLE_CHARS) {
        return jsonError(c, 400, "bad_request", `title must be at most ${MAX_TITLE_CHARS} characters`);
      }
      change.title = title;
    }

    if ("pinned" in body) {
      const pinned = body["pinned"];
      if (typeof pinned !== "boolean") return jsonError(c, 400, "bad_request", "pinned must be a boolean");
      change.pinned = pinned;
    }

    // Finite only: Infinity or NaN would break the list's sort order.
    if ("rank" in body) {
      const rank = body["rank"];
      if (rank !== null && !(typeof rank === "number" && Number.isFinite(rank))) {
        return jsonError(c, 400, "bad_request", "rank must be a finite number or null");
      }
      change.rank = rank;
    }

    if (change.title === undefined && change.pinned === undefined && change.rank === undefined) {
      return jsonError(c, 400, "bad_request", 'body must carry at least one of {"title"}, {"pinned"} or {"rank"}');
    }

    return c.json({ session: managed.setMeta(change) });
  }));

  app.post("/sessions/:id/permissions/:permissionId", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;
    const answer = parseAnswer(body);
    if (!answer) {
      return jsonError(
        c,
        400,
        "bad_request",
        'body must carry exactly one of {"optionId"}, {"decision"} or {"cancel":true}',
      );
    }

    const result = managed.answerPermission(c.req.param("permissionId"), answer);
    switch (result.kind) {
      case "ok":
        return c.json({
          recorded: true,
          permissionId: result.permissionId,
          outcome: result.outcome,
          optionId: result.optionId,
          by: "client",
          repeat: false,
          // Recorded, not proven delivered: a send to a gone agent is swallowed; only a later event proves effect.
          delivered: result.delivered,
          seq: result.seq,
          session: managed.snapshot(),
        });
      case "already_answered":
        return c.json(
          {
            recorded: true,
            permissionId: result.permissionId,
            outcome: result.outcome,
            optionId: result.optionId,
            by: result.by,
            repeat: true,
            at: result.at,
            session: managed.snapshot(),
          },
          409,
        );
      case "expired":
        return jsonError(c, 409, "permission_expired", "that permission was settled and forgotten");
      case "invalid_option":
        return jsonError(c, 400, "invalid_option", "the agent did not offer that option", {
          options: result.options,
        });
      case "no_matching_option":
        return jsonError(c, 400, "no_matching_option", "the agent offered no option matching that decision", {
          options: result.options,
        });
      case "not_found":
        return jsonError(c, 404, "permission_not_found", "no such permission on this session");
    }
  }));

  app.get("/sessions/:id/elicitations/:elicitationId", read, withSession((c, managed) => {
    const form = managed.elicitationForm(c.req.param("elicitationId"));
    if (!form) {
      return jsonError(c, 404, "elicitation_not_found", "no such question waiting on this session");
    }
    return c.json({ elicitationId: c.req.param("elicitationId"), fields: form.fields });
  }));

  app.post("/sessions/:id/elicitations/:elicitationId", write, withSession(async (c, managed) => {

    const body = await requireJson(c);
    if (body instanceof Response) return body;
    const answer = parseElicitationAnswer(body);
    if (!answer) {
      return jsonError(
        c,
        400,
        "bad_request",
        'body must carry exactly one of {"content"}, {"decline":true} or {"cancel":true}',
      );
    }

    const result = managed.answerElicitation(c.req.param("elicitationId"), answer);
    switch (result.kind) {
      case "ok":
        return c.json({
          recorded: true,
          elicitationId: result.elicitationId,
          action: result.action,
          by: "client",
          repeat: false,
          delivered: result.delivered,
          seq: result.seq,
          session: managed.snapshot(),
        });
      case "already_answered":
        // A 409 with a success-shaped body: the answer landed, and action is the one that won.
        return c.json(
          {
            recorded: true,
            elicitationId: result.elicitationId,
            action: result.action,
            by: result.by,
            repeat: true,
            at: result.at,
            session: managed.snapshot(),
          },
          409,
        );
      case "expired":
        return jsonError(c, 409, "elicitation_expired", "that question was settled and forgotten");
      case "invalid_content":
        return jsonError(c, 400, "invalid_content", "that is not an answer to this form", {
          problems: result.problems,
          fields: result.fields,
        });
      case "not_found":
        return jsonError(c, 404, "elicitation_not_found", "no such question on this session");
    }
  }));

  app.get("/sessions/:id/events", read, withSession((c, managed) => {

    const since = boundedInt(c.req.query("since"), 0);
    const limit = boundedInt(c.req.query("limit"), EVENTS_PAGE_LIMIT, EVENTS_PAGE_LIMIT);
    const stats = managed.log.stats();
    return c.json({
      events: managed.log.read(since, limit, EVENTS_PAGE_BYTES),
      // The derived floor, not raw firstSeq: they differ when the log is empty but the sequence is not.
      firstSeq: oldestAvailable(stats),
      lastSeq: stats.lastSeq,
      dropped: stats.dropped,
      gap: since < oldestAvailable(stats) - 1,
    });
  }));

  app.get("/sessions/:id/commands", read, withSession((c, managed) => {
    const { commands, dropped } = managed.agentCommands;
    return c.json({ revision: managed.commandsRevision, commands, dropped });
  }));

  app.get("/sessions/:id/changes", read, withSession(async (c, managed) => {
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    try {
      const changes = await listChanges(managed.workspace, {
        runner: git,
        base: c.req.query("base") === "head" ? "head" : "session",
        includeIgnored: c.req.query("ignored") === "1",
        limit: boundedInt(c.req.query("limit"), maxChangedFiles, maxChangedFiles),
      });
      return c.json({ ...changes, now: Date.now() });
    } catch (error) {
      return gitError(c, error);
    }
  }));

  app.get("/sessions/:id/changes/diff", read, withSession(async (c, managed) => {
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    const safe = await requestedPath(c, managed);
    if (safe instanceof Response) return safe;

    const base = c.req.query("base") === "head" ? "head" : "session";
    try {
      // Recomputed, not trusted: the servable paths are exactly what git just reported.
      const changes = await listChanges(managed.workspace, {
        runner: git,
        base,
        includeIgnored: true,
        limit: maxChangedFiles,
      });
      if (!changes.supported) {
        return jsonError(c, 409, "not_a_git_repository", "this session is not running in a git repository");
      }
      const change = changes.files.find((file) => file.path === safe.rel);
      if (!change) {
        return jsonError(c, 404, "path_not_changed", "this session did not change that file");
      }
      if (!change.addressable) {
        return jsonError(c, 400, "path_not_addressable", "that path is not valid UTF-8 and cannot be requested");
      }

      const diff = await diffFile(managed.workspace, change, {
        runner: git,
        base,
        contextLines: boundedInt(c.req.query("context"), 3, 32),
        maxBytes: maxDiffBytes,
      });
      return c.json(diff);
    } catch (error) {
      return gitError(c, error);
    }
  }));

  // Not limited to the change set on purpose: the agent can already read anything under this root.
  app.get("/sessions/:id/files", read, withSession(async (c, managed) => {
    // Mandatory: for a plain session the root is the caller's own cwd, which may be a stalled mount.
    const gate = await workspaceReady(c, managed);
    if (gate) return gate;

    const safe = await requestedPath(c, managed);
    if (safe instanceof Response) return safe;

    return serveFile(c, safe.full, safe.rel.slice(safe.rel.lastIndexOf("/") + 1));
  }));

  app.get("/sessions/:id/uploads/:uploadId", read, withSession(async (c, managed) => {
    if (!uploads) return jsonError(c, 503, "uploads_unavailable", "this daemon has no upload store");

    const row = uploads.find(managed.id, c.req.param("uploadId") ?? "");
    if (row === null) {
      return jsonError(c, 404, "upload_not_found", "no such upload on this session");
    }
    return serveFile(c, uploads.pathFor(row), row.name);
  }));

  app.get("/sessions/:id/workspace", read, withSession(async (c, managed) => {
    try {
      return c.json({ workspace: managed.workspace, status: await inspectWorkspace(managed.workspace, git) });
    } catch (error) {
      return gitError(c, error);
    }
  }));

  app.delete("/sessions/:id/workspace", admin, withSession(async (c, managed) => {
    // keepsItsConversation too: removing a parked or interrupted session's worktree would strand it for good.
    if (!managed.terminal || keepsItsConversation(managed.exit)) {
      return jsonError(c, 409, "session_live", "stop this session before removing its worktree", {
        status: managed.status,
      });
    }

    try {
      const result = await removeWorkspace({
        runner: git,
        workspace: managed.workspace,
        // The root POST /sessions created it under, so the containment check guarding the rmSync agrees with creation.
        worktreeRoot: registry.workspacePolicy.worktreeRoot,
        force: c.req.query("force") === "1",
        deleteBranch: c.req.query("deleteBranch") === "1",
      });

      switch (result.kind) {
        case "not_applicable":
          return jsonError(c, 409, "not_a_worktree", "this session runs in a plain directory we did not create");
        case "refused": {
          const answer = removalRefusalAnswer(result.refusals);
          return jsonError(c, 409, answer.code, answer.message, {
            refusals: result.refusals,
            status: result.status,
          });
        }
        case "removed": {
          // Only unconsumed uploads go: the session and its transcript survive and still name consumed ones. A failure is a warning.
          const warnings = [...result.warnings];
          if (uploads) {
            try {
              await uploads.forgetUnconsumed(managed.id);
            } catch (error) {
              warnings.push(
                `staged uploads were not removed: ${describeError(error)}`,
              );
            }
          }
          return c.json({
            removed: true,
            branchDeleted: result.branchDeleted,
            pruned: result.pruned,
            warnings,
          });
        }
      }
    } catch (error) {
      return gitError(c, error);
    }
  }));

  app.get("/worktrees", read, async (c) => {
    const known = registry.list();
    const worktreeRoot = registry.workspacePolicy.worktreeRoot;
    // The root is resolved once through the bounded probe; a root that did not answer is 503, never an empty list.
    const rootReal = await probeRealpath(worktreeRoot);
    if (rootReal === null) {
      return jsonError(c, 503, "worktree_root_unresponsive", "the filesystem holding the worktree root did not answer", {
        timeoutMs: DESCRIBE_TIMEOUT_MS,
      });
    }
    const realRoot = rootReal.kind === "path" ? rootReal.value : worktreeRoot;

    const owners = new Map<string, { sessionId: string; status: string }>();
    for (const session of known) {
      if (session.workspace.mode === "worktree") {
        owners.set(session.workspace.root, { sessionId: session.id, status: session.status });
      }
    }

    const repos = new Set<string>();
    for (const session of known) {
      const repoRoot = session.workspace.git?.repoRoot;
      if (repoRoot) repos.add(repoRoot);
    }

    const entries: unknown[] = [];
    for (const repoRoot of repos) {
      let listed: Awaited<ReturnType<typeof listWorktrees>>;
      try {
        listed = await listWorktrees(repoRoot, git);
      } catch {
        // One unreadable repo must not cost the whole listing.
        continue;
      }
      for (const entry of listed) {
        if (entry.path === repoRoot) continue;
        // Resolved, then compared segment-wise; a path that did not answer is dropped, and a missing one is compared as written.
        const seen = await probeRealpath(entry.path);
        if (seen === null) continue;
        if (!containedInResolved(seen.kind === "path" ? seen.value : entry.path, realRoot)) continue;
        entries.push({ ...entry, repoRoot, owner: owners.get(entry.path) ?? null });
      }
    }
    return c.json({ root: worktreeRoot, worktrees: entries });
  });

  // Plugins: these scopes decide what the caller may do, manifest.scopes what the plugin may do; neither implies the other.

  const withPlugins =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, host: PluginHost) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    (c) => {
      if (!plugins) return jsonError(c, 503, "plugins_unavailable", "this daemon has no plugin host");
      return handler(c, plugins);
    };

  const pluginNotFound = (c: Context<AppEnv>): Response =>
    jsonError(c, 404, "plugin_not_found", "no such plugin on this machine");

  const withPlugin =
    <P extends string>(
      handler: (c: Context<AppEnv, P>, plugin: LivePlugin) => Response | Promise<Response>,
    ): Handler<AppEnv, P> =>
    withPlugins((c, host) => {
      const plugin = host.find(c.req.param("pluginId") ?? "");
      if (plugin === null) return pluginNotFound(c);
      return handler(c, plugin);
    });

  app.get(
    "/plugins",
    read,
    withPlugins((c, host) => c.json({ plugins: host.list(), api: PLUGIN_API_VERSION })),
  );

  app.post(
    "/plugins",
    admin,
    withPlugins(async (c, host) => {
      const refuse = async <T,>(answer: () => T): Promise<T> => {
        await cancelBody(c.req.raw.body as ReadableStream<Uint8Array> | null);
        return answer();
      };

      if (registry.isShuttingDown) {
        return refuse(() => jsonError(c, 503, "shutting_down", "the daemon is shutting down"));
      }

      const named = sanitizeUploadName(c.req.query("name") ?? "");
      if (!named.ok) {
        return refuse(() =>
          jsonError(c, 400, "invalid_name", "that filename cannot be stored", { reason: named.reason }),
        );
      }

      // Honoured to refuse, never to accept.
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > PLUGIN_LIMITS.maxBytes) {
        return refuse(() =>
          jsonError(c, 413, "plugin_too_large", `a plugin archive may not exceed ${PLUGIN_LIMITS.maxBytes} bytes`, {
            limit: PLUGIN_LIMITS.maxBytes,
            declared,
          }),
        );
      }

      const body = c.req.raw.body;
      if (body === null) return jsonError(c, 400, "bad_request", "expected a request body");

      const outcome = await host.install({ body, name: named.name });
      if (outcome.kind === "ok") {
        return c.json({ plugin: outcome.summary, replaced: outcome.replaced }, outcome.replaced === null ? 201 : 200);
      }
      if (outcome.kind === "busy") {
        return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      }
      return jsonError(c, pluginInstallStatus(outcome.code), outcome.code, outcome.message);
    }),
  );

  // Not a streaming route: the body is small JSON. The address is built from repo and commit alone; no URL is accepted.
  app.post(
    "/plugins/source",
    admin,
    withPlugins(async (c, host) => {
      if (registry.isShuttingDown) return jsonError(c, 503, "shutting_down", "the daemon is shutting down");

      const body = await requireJson(c);
      if (body instanceof Response) return body;

      const source = readSource(body["source"] ?? body);
      if (isSourceRefusal(source)) return jsonError(c, 400, source.code, source.message);

      const consent = readConsent(body["consent"]);

      const outcome = await host.installFromSource(source, consent);
      if (outcome.kind === "ok") {
        return c.json({ plugin: outcome.summary, replaced: outcome.replaced }, outcome.replaced === null ? 201 : 200);
      }
      if (outcome.kind === "busy") {
        return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      }
      return jsonError(c, pluginInstallStatus(outcome.code), outcome.code, outcome.message);
    }),
  );

  // remove rather than a lookup, so an unreadable install is removable too.
  // An unknown id is 200 removed false, never 404: the transport replays DELETE.
  app.delete(
    "/plugins/:pluginId",
    admin,
    withPlugins(async (c, host) => {
      const removed = await host.remove(c.req.param("pluginId") ?? "");
      if (removed === "busy") return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      return c.json({ removed });
    }),
  );

  app.post(
    "/plugins/:pluginId/state",
    admin,
    withPlugins(async (c, host) => {
      const body = await requireJson(c);
      if (body instanceof Response) return body;
      const enabled = body["enabled"];
      if (typeof enabled !== "boolean") return jsonError(c, 400, "bad_request", "enabled must be true or false");
      const summary = await host.setEnabled(c.req.param("pluginId") ?? "", enabled);
      if (summary === "busy") return jsonError(c, 409, "plugin_busy", "this machine is already installing a plugin");
      if (summary === null) return pluginNotFound(c);
      return c.json({ plugin: summary });
    }),
  );

  app.get(
    "/plugins/:pluginId/views/:viewId",
    read,
    withPlugin((c, plugin) => {
      const viewId = c.req.param("viewId") ?? "";
      if (viewId !== "screen" && viewId !== "settings") {
        return jsonError(c, 404, "view_not_found", "a plugin draws a screen and a settings pane, and no other view");
      }
      // Must be a view this plugin declares, or the child throws and a working plugin is reported as a 502.
      const contributes = plugin.record.manifest.contributes;
      const declares = viewId === "settings" ? contributes.settings : contributes.screen !== null;
      if (!declares) return jsonError(c, 404, "view_not_found", "this plugin declares no such view");
      return pluginAnswer(c, () => plugin.invoke("view", viewId, { view: viewId }));
    }),
  );

  app.post(
    "/plugins/:pluginId/actions/:actionId",
    write,
    withPlugin(async (c, plugin) => {
      const actionId = c.req.param("actionId") ?? "";
      const body = await requireJson(c);
      if (body instanceof Response) return body;
      // Only actions the manifest declared; a plugin need not defend against ids it never declared.
      if (!plugin.record.manifest.contributes.actions.some((one) => one.id === actionId)) {
        return jsonError(c, 404, "action_not_found", "this plugin declares no such action");
      }
      return pluginAnswer(c, () =>
        plugin.invoke("action", actionId, {
          action: actionId,
          session: typeof body["session"] === "string" ? body["session"] : null,
          row: typeof body["row"] === "string" ? body["row"] : null,
          form: body["form"] ?? null,
        }),
      );
    }),
  );

  // The stream is read-only: everything that mutates is an HTTP request.

  app.get(
    "/sessions/:id/stream",
    read,
    async (c, next) => {
      if (!sessionOf(c)) return notFound(c);
      return next();
    },
    upgradeWebSocket((c) => {
      const managed = sessionOf(c);
      const sinceParam = c.req.query("since");
      const since = sinceParam === undefined ? null : boundedInt(sinceParam, 0);
      // Read in the handshake: the socket outlives this request context.
      const expiresAt = c.get("principal").expiresAt;
      let connection: StreamConnection | null = null;

      return {
        onOpen(_event, ws) {
          if (!managed) {
            ws.close(4404, "session not found");
            return;
          }
          connection = new StreamConnection(managed, ws as WSContext<RawWebSocket>, instanceId, expiresAt);
          connection.attach(since);
        },
        onClose() {
          connection?.dispose();
          connection = null;
        },
        onError() {
          connection?.dispose();
          connection = null;
        },
      };
    }),
  );

  return { app, injectWebSocket: guardedInjectWebSocket(injectWebSocket) };
}

// Answers upgrade targets the URL parser rejects with a 400: a throw leaks the socket, since keepAliveTimeout arms only after a response.
// Wrapped rather than prepended: every upgrade listener runs.
function guardedInjectWebSocket(inject: (server: Server) => void): (server: Server) => void {
  return (server) => {
    inject(server);
    const injected = server.listeners("upgrade") as ((
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void)[];
    server.removeAllListeners("upgrade");
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      try {
        new URL(request.url ?? "/", "http://localhost");
      } catch {
        // Node removes its socket error handler before emitting upgrade, so one is needed before writing.
        socket.on("error", () => socket.destroy());
        try {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        } catch {
          // Peer already gone; the destroy below is all that is left to do.
        }
        socket.destroy();
        return;
      }
      for (const listener of injected) listener(request, socket, head);
    });
  };
}

type QueueItem =
  | { kind: "event"; stored: StoredEvent; bytes: number }
  | { kind: "control"; payload: string; bytes: number };

// Nothing here may slow the agent: the log listener is a synchronous push, and a lagging client is degraded at nobody else's cost.
class StreamConnection {
  private readonly queue: QueueItem[] = [];
  private queuedBytes = 0;
  private cursor = 0;
  private lastSentSeq = 0;
  private sending = false;
  private closed = false;
  private alive = true;
  private collapses: number[] = [];
  private unsubLog: (() => void) | null = null;
  private unsubWatch: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly managed: ManagedSession,
    private readonly ws: WSContext<RawWebSocket>,
    private readonly instanceId: string,
    // Checked on the heartbeat, so an expiry while the socket is open closes it; null never expires.
    private readonly expiresAt: number | null = null,
  ) {}

  private get raw(): RawWebSocket | undefined {
    return this.ws.raw;
  }

  // No await between reading the backlog and subscribing, so no event lands in neither; the seq filter in emit makes an overlap harmless.
  attach(sinceParam: number | null): void {
    const stats = this.managed.log.stats();
    const asked = sinceParam === null ? stats.lastSeq : Math.min(sinceParam, stats.lastSeq);

    // Replays at most ATTACH_REPLAY_MAX; the rest is reported as lagged backlog, which GET /sessions/:id/events serves.
    const floor = Math.max(asked, stats.lastSeq - ATTACH_REPLAY_MAX);
    const since = Math.max(asked, Math.min(floor, stats.lastSeq));
    this.cursor = since;
    this.lastSentSeq = since;

    const oldest = oldestAvailable(stats);
    const gap = asked < oldest - 1;
    this.control({
      type: "hello",
      instanceId: this.instanceId,
      session: this.managed.snapshot(),
      firstSeq: oldest,
      lastSeq: stats.lastSeq,
      since,
      gap,
    });
    if (gap) {
      this.control({
        type: "lagged",
        from: asked + 1,
        to: oldest - 1,
        dropped: oldest - 1 - asked,
        reason: "evicted",
      });
    }
    const skippedFrom = Math.max(asked, oldest - 1) + 1;
    if (since >= skippedFrom) {
      this.control({
        type: "lagged",
        from: skippedFrom,
        to: since,
        dropped: since - skippedFrom + 1,
        reason: "backlog",
      });
    }

    for (;;) {
      const slice = this.managed.log.read(this.cursor, BATCH_MAX_EVENTS, BATCH_MAX_BYTES);
      if (slice.length === 0) break;
      for (const stored of slice) this.emit(stored, true);
    }

    this.unsubLog = this.managed.log.subscribe((stored) => this.emit(stored));
    this.unsubWatch = this.managed.watch((snapshot) => this.control({ type: "snapshot", session: snapshot }));
    this.control({ type: "caught_up", seq: this.cursor });

    const raw = this.raw;
    if (raw) {
      raw.on("pong", () => {
        this.alive = true;
      });
      this.heartbeat = setInterval(() => {
        // Re-authorization: otherwise a short-lived token buys an unbounded connection that revocation never reaches.
        if (this.expiresAt !== null && Date.now() > this.expiresAt + AUTH_LEEWAY_MS) {
          this.close(4401, "token expired");
          return;
        }
        if (!this.alive) {
          raw.terminate();
          return;
        }
        this.alive = false;
        try {
          raw.ping();
        } catch {
          raw.terminate();
        }
      }, PING_INTERVAL_MS);
    }

    this.flush();
  }

  // bytes is retained heap for MAX_QUEUE_BYTES, deliberately not the wire bytes a batch is cut on.
  private emit(stored: StoredEvent, replaying = false): void {
    if (this.closed || stored.seq <= this.cursor) return;
    this.cursor = stored.seq;
    this.enqueue({ kind: "event", stored, bytes: estimateBytes(stored.event) + 64 }, replaying);
  }

  private control(frame: unknown): void {
    if (this.closed) return;
    this.enqueue(controlItem(frame));
  }

  private enqueue(item: QueueItem, replaying = false): void {
    this.push(item);
    if (this.queue.length > MAX_QUEUE_EVENTS || this.queuedBytes > MAX_QUEUE_BYTES) {
      this.collapse(replaying ? "backlog" : "slow_consumer");
      return;
    }
    this.flush();
  }

  private push(item: QueueItem): void {
    this.queue.push(item);
    this.queuedBytes += item.bytes;
  }

  // The reason matters: slow_consumer is a hole, while backlog is still on disk and refetched over HTTP.
  private collapse(reason: "slow_consumer" | "backlog"): void {
    const head = this.managed.log.stats().lastSeq;
    const from = this.lastSentSeq + 1;
    this.queue.length = 0;
    this.queuedBytes = 0;

    // Pushed, not enqueued: these frames are the response to the ceiling.
    if (head >= from) {
      this.push(controlItem({ type: "lagged", from, to: head, dropped: head - from + 1, reason }));
    }
    this.cursor = head;
    this.lastSentSeq = head;
    this.push(controlItem({ type: "snapshot", session: this.managed.snapshot() }));

    // Only a real slow consumer counts toward the disconnect.
    if (reason !== "slow_consumer") return;
    const now = Date.now();
    this.collapses = this.collapses.filter((at) => now - at < COLLAPSE_WINDOW_MS);
    this.collapses.push(now);
    if (this.collapses.length >= 2) this.close(4003, "slow consumer");
  }

  private flush(): void {
    if (this.closed || this.sending) return;
    const raw = this.raw;
    if (!raw || raw.readyState !== 1 /* OPEN */) return;
    if (raw.bufferedAmount > SOCKET_HIGH_WATER) return;

    const head = this.queue[0];
    if (!head) return;

    let payload: string;
    if (head.kind === "control") {
      this.queue.shift();
      this.queuedBytes -= head.bytes;
      payload = head.payload;
    } else {
      const encoded: string[] = [];
      let bytes = EVENTS_FRAME_OPEN.length + EVENTS_FRAME_CLOSE.length;
      let lastSeq: number | null = null;
      while (this.queue.length > 0 && encoded.length < BATCH_MAX_EVENTS) {
        const next = this.queue[0]!;
        if (next.kind !== "event") break;
        const one = encodeStored(next.stored);
        const size = Buffer.byteLength(one, "utf8") + (encoded.length > 0 ? 1 : 0);
        // The first event is taken whatever it weighs, or one oversized event would stall the batch forever.
        if (encoded.length > 0 && bytes + size > BATCH_MAX_BYTES) break;
        this.queue.shift();
        this.queuedBytes -= next.bytes;
        encoded.push(one);
        bytes += size;
        lastSeq = next.stored.seq;
      }
      if (lastSeq !== null) this.lastSentSeq = lastSeq;
      payload = `${EVENTS_FRAME_OPEN}${encoded.join(",")}${EVENTS_FRAME_CLOSE}`;
    }

    this.sending = true;
    raw.send(payload, (error) => {
      this.sending = false;
      if (error) {
        this.close(1011, "send failed");
        return;
      }
      if (this.queue.length > 0) this.flush();
    });
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.dispose();
    try {
      this.ws.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.unsubLog?.();
    this.unsubWatch?.();
    this.unsubLog = null;
    this.unsubWatch = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

// A present Authorization header is authoritative even when malformed; the token query parameter is read only on a WebSocket handshake.
function readCredential(c: Context): string | null {
  // Null check, not falsiness: a present but malformed header yields an empty string and must not fall through to the query.
  const fromHeader = bearerToken(c.req.header("authorization"));
  if (fromHeader !== null) return fromHeader;
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return null;
  return c.req.query("token") ?? null;
}

const DECISION_WORDS = ["allow", "allow_always", "reject", "reject_always"] as const;

function parseAnswer(body: Record<string, unknown>): PermissionAnswer | null {
  const forms = [
    typeof body["optionId"] === "string",
    typeof body["decision"] === "string",
    body["cancel"] === true,
  ].filter(Boolean).length;
  // Exactly one, so an ambiguous body is never silently resolved one way.
  if (forms !== 1) return null;

  if (typeof body["optionId"] === "string") return { optionId: body["optionId"] };
  if (body["cancel"] === true) return { cancel: true };
  const decision = body["decision"];
  if (typeof decision === "string" && (DECISION_WORDS as readonly string[]).includes(decision)) {
    return { decision: decision as (typeof DECISION_WORDS)[number] };
  }
  return null;
}

// Exactly one form. decline runs the tool with empty answers and the turn carries on; cancel aborts the tool call.
function parseElicitationAnswer(body: Record<string, unknown>): ElicitationAnswerBody | null {
  const content = body["content"];
  const isObject = typeof content === "object" && content !== null && !Array.isArray(content);
  const forms = [isObject, body["decline"] === true, body["cancel"] === true].filter(Boolean).length;
  if (forms !== 1) return null;

  if (isObject) return { content: content as Record<string, ElicitationContentValue> };
  if (body["decline"] === true) return { decline: true };
  return { cancel: true };
}

// Encoded once here so bytes is the retained heap, then fitted under CONTROL_MAX_BYTES; an ordinary frame pays one byteLength.
function controlItem(frame: unknown): QueueItem {
  const built = safeStringify(frame);
  if (Buffer.byteLength(built, "utf8") <= CONTROL_MAX_BYTES) return heldFrame(built);
  return heldFrame(fitSnapshotFrame(frame, built));
}

function heldFrame(payload: string): QueueItem {
  return { kind: "control", payload, bytes: payload.length + 64 };
}

/**
 * Exported for daemoncheck only. Rung one clamps permission blobs and outputFilePath; rung two halves the parked lists, floor one each.
 * The last rung is sent whatever it weighs: agentSessionId and agentHandle are bounded nowhere.
 */
export function fitSnapshotFrame(frame: unknown, built: string): string {
  const session = snapshotOnFrame(frame);
  if (session === null) return built;
  // The contract: nothing comes back marked reduced without having been.
  if (Buffer.byteLength(built, "utf8") <= CONTROL_MAX_BYTES) return built;
  const rest = frame as Record<string, unknown>;

  const trimmed: SessionSnapshot = {
    ...session,
    reduced: {
      pendingPermissions: session.pendingPermissions.length,
      pendingElicitations: session.pendingElicitations.length,
      blobs: true,
    },
    backgroundTasks: session.backgroundTasks.map((task) => ({ ...task, outputFilePath: null })),
    pendingPermissions: session.pendingPermissions.map((pending) => ({
      ...pending,
      rawInput: clampBlob(pending.rawInput, 0),
      content: clampBlob(pending.content, 0),
    })),
  };
  let payload = safeStringify({ ...rest, session: trimmed });
  if (Buffer.byteLength(payload, "utf8") <= CONTROL_MAX_BYTES) return payload;

  let keep = Math.max(trimmed.pendingPermissions.length, trimmed.pendingElicitations.length);
  while (keep > 1) {
    keep = Math.floor(keep / 2);
    payload = safeStringify({
      ...rest,
      session: {
        ...trimmed,
        pendingPermissions: trimmed.pendingPermissions.slice(0, keep),
        pendingElicitations: trimmed.pendingElicitations.slice(0, keep),
      },
    });
    if (Buffer.byteLength(payload, "utf8") <= CONTROL_MAX_BYTES) return payload;
  }
  return payload;
}

function snapshotOnFrame(frame: unknown): SessionSnapshot | null {
  if (typeof frame !== "object" || frame === null) return null;
  const session = (frame as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return null;
  const snapshot = session as SessionSnapshot;
  return Array.isArray(snapshot.backgroundTasks) &&
    Array.isArray(snapshot.pendingPermissions) &&
    Array.isArray(snapshot.pendingElicitations)
    ? snapshot
    : null;
}

// Never a hole: a dropped seq makes the client reconnect onto the same batch forever, so the event becomes an error stand-in.
function encodeStored(stored: StoredEvent): string {
  try {
    return JSON.stringify(stored);
  } catch (error) {
    return JSON.stringify({
      seq: stored.seq,
      ts: stored.ts,
      event: { type: "error", message: `event could not be encoded: ${describeError(error)}`, data: null },
    });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return JSON.stringify({ type: "error", code: "unserializable", message: "frame could not be encoded" });
  }
}

function notFound(c: Context): Response {
  return jsonError(c, 404, "session_not_found", "no such session on this daemon");
}

// counts_unknown means the daemon could not tell, so it gets its own code; definite refusals keep workspace_dirty, which scripts/client.ts keys its force hint on.
function removalRefusalAnswer(refusals: readonly RemoveRefusal[]): { code: string; message: string } {
  const definite = refusals.filter((refusal) => refusal.code !== "counts_unknown");
  if (definite.length === 0) {
    return {
      code: "workspace_uncertain",
      message: "could not tell whether removing this worktree would lose work; force removes it anyway",
    };
  }
  const holdsWork = definite.some((refusal) => refusal.code !== "locked");
  return {
    code: "workspace_dirty",
    message: holdsWork ? "this worktree still holds work" : "this worktree is locked",
  };
}

function pathErrorStatus(error: PathError, fallback: 400 | 404): 400 | 403 | 404 | 503 {
  if (error.code === "outside_roots") return 403;
  if (error.code === "unresponsive") return 503;
  return fallback;
}

function errnoError(c: Context, error: unknown, fallback: 400 | 404): Response | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== "string") return null;
  const message = describeError(error);
  if (code === "ENOENT") return jsonError(c, 404, "not_found", message);
  if (code === "ENOTDIR") return jsonError(c, 400, "not_a_directory", message);
  if (code === "EACCES" || code === "EPERM") return jsonError(c, 403, "invalid_path", message);
  if (code === "ELOOP" || code === "ENAMETOOLONG") return jsonError(c, 400, "invalid_path", message);
  return jsonError(c, fallback, "invalid_path", message);
}

// Truncation order: waiting on a human, pinned, live, terminal. rank is deliberately not read: a position buys no retention.
function listRank(session: SessionSnapshot): number {
  if (awaitingHuman(session)) return 0;
  if (session.pinned) return 1;
  return session.exit === null ? 2 : 3;
}

// Always octet-stream, attachment, nosniff and no-store: a rendered HTML or SVG response would run on the daemon's origin.
async function serveFile(c: Context, full: string, name: string): Promise<Response> {
  const probe = await probeFile(full);
  if (probe === null) {
    return jsonError(c, 503, "file_unresponsive", "the filesystem holding that file did not answer", {
      timeoutMs: DESCRIBE_TIMEOUT_MS,
    });
  }
  if (probe.kind !== "file") {
    return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
  }
  if (probe.size > MAX_DOWNLOAD_BYTES) {
    return jsonError(c, 413, "file_too_large", "that file is too large to download", {
      bytes: probe.size,
      limit: MAX_DOWNLOAD_BYTES,
    });
  }

  // Opened once with O_NOFOLLOW and everything read off that handle: an agent could swap the leaf for a symlink after the probe.
  let handle: Awaited<ReturnType<typeof openFile>>;
  try {
    handle = await openFile(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    // Every errno gets the probe's 404: saying which would confirm what is there.
    return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
  }

  let size: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close().catch(() => {
        // Nothing to do; the descriptor dies with the process at worst.
      });
      return jsonError(c, 404, "not_a_regular_file", "that path is not a regular file");
    }
    size = info.size;
  } catch (error) {
    await handle.close().catch(() => {
      // As above.
    });
    return jsonError(c, 503, "file_unresponsive", "the filesystem holding that file did not answer", {
      detail: describeError(error),
    });
  }

  if (size > MAX_DOWNLOAD_BYTES) {
    await handle.close().catch(() => {
      // As above.
    });
    return jsonError(c, 413, "file_too_large", "that file is too large to download", {
      bytes: size,
      limit: MAX_DOWNLOAD_BYTES,
    });
  }

  const stream = handle.createReadStream();
  // The error listener first: an unhandled stream error is an uncaught exception.
  stream.on("error", () => stream.destroy());

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": contentDispositionFor(name),
      "content-length": String(size),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

async function workspaceReady(c: Context, managed: ManagedSession): Promise<Response | null> {
  // Never a synchronous check: for a plain session the root is the caller's cwd and may be a stalled mount. Gone is 409, not answering 503.
  const present = await probeExists(managed.workspace.root);
  if (present === true) return null;
  if (present === null) {
    return jsonError(
      c,
      503,
      "workspace_unresponsive",
      `${managed.workspace.root} did not answer; the filesystem it is on may have stalled`,
      { workspace: managed.workspace },
    );
  }
  return jsonError(c, 409, "workspace_missing", `${managed.workspace.root} no longer exists`, {
    workspace: managed.workspace,
  });
}

function gitError(c: Context, error: unknown): Response {
  if (error instanceof WorktreeError) return worktreeError(c, error);
  if (error instanceof GitError) {
    if (error.code === "git_missing") {
      return jsonError(c, 503, "git_missing", error.message);
    }
    if (error.code === "git_timeout") {
      return jsonError(c, 504, "git_timeout", error.message);
    }
    return jsonError(c, 502, error.code, error.message, { stderr: error.stderr.trim() });
  }
  throw error;
}

function worktreeError(c: Context, error: WorktreeError): Response {
  switch (error.code) {
    case "git_missing":
    case "worktree_root_unwritable":
      return jsonError(c, 503, error.code, error.message, error.detail);
    case "git_timeout":
      return jsonError(c, 504, error.code, error.message, error.detail);
    case "git_failed":
    case "git_output_too_large":
      return jsonError(c, 502, error.code, error.message, error.detail);
    default:
      return jsonError(c, 409, error.code, error.message, error.detail);
  }
}

export type { SessionSnapshot };

async function pluginAnswer(c: Context, run: () => Promise<PluginResult>): Promise<Response> {
  try {
    const result = await run();
    return c.json({ result });
  } catch (error) {
    if (error instanceof PluginApiError) {
      return jsonError(c, pluginErrorStatus(error.code), error.code, error.message);
    }
    throw error;
  }
}

// Read the code, never the status: off or broken is 503, remedy on this machine; anything else 502.
function pluginErrorStatus(code: string): 403 | 413 | 502 | 503 | 504 {
  if (code === "plugin_unavailable") return 503;
  if (code === "plugin_timeout") return 504;
  if (code === "plugin_overloaded") return 503;
  if (code === "plugin_scope_denied") return 403;
  // 413: the message never reached the child because it does not fit one IPC frame.
  if (code === "plugin_request_too_large") return 413;
  return 502;
}

function pluginInstallStatus(code: string): 400 | 409 | 413 | 502 | 503 {
  switch (code) {
    case "plugin_too_large":
    case "plugin_unpacked_too_large":
    case "plugin_too_many_entries":
      return 413;
    case "plugin_start_failed":
    case "plugin_consent_broken":
      return 409;
    case "plugin_write_failed":
      return 503;
    case "plugin_source_unavailable":
    case "plugin_source_not_found":
      return 502;
    default:
      return 400;
  }
}
