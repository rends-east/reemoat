#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import type { ChangeSet, DiffResult } from "../src/changes.js";
import { endedWithDaemon, type SessionEvent, type StoredEvent } from "../src/events.js";
import type { PendingPermissionSnapshot, SessionSnapshot } from "../src/registry.js";
import type { AgentAvailability } from "../src/runtime/types.js";
import { PLUGIN_LIMITS, unpackArchive } from "../src/archive.js";
import { parseManifest } from "../src/plugins/manifest.js";
import { addedLines } from "../src/plugins/source.js";
import type { PluginManifest, PluginSummary } from "../src/plugins/protocol.js";
import type { WorkspaceStatus } from "../src/worktree.js";

const STATIC_TOKEN = process.env["REEMOAT_TOKEN"] ?? "";

/** Control-plane mode: with all three set, a short-lived token for one machine is minted and renewed before it expires. */
const CP_URL = (process.env["REEMOAT_CP_URL"] ?? "").trim();
const CP_KEY = (process.env["REEMOAT_CP_KEY"] ?? "").trim();
const MACHINE = (process.env["REEMOAT_MACHINE"] ?? "").trim();
const CP_MODE = CP_URL.length > 0 && CP_KEY.length > 0 && MACHINE.length > 0;

// 7887 matches the daemon's own default. See `DEFAULT_PORT` in scripts/daemon.ts.
const BASE_URL = process.env["REEMOAT_URL"] ?? "http://127.0.0.1:7887";

if ((process.env["REEMOAT_ROUTE"] ?? "").trim().length > 0) {
  warn("!! REEMOAT_ROUTE is set and no longer does anything: the relay is the only path");
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** After a 4003 the daemon has dropped queued events; reconnecting at once earns a second collapse. Same value in packages/web/src/stream.ts. */
const SLOW_CONSUMER_BACKOFF_MS = 5_000;
const TEXT_PREVIEW = 400;
/** Renew with this much life left: larger than the daemon's 60s clock leeway, so a renewal never depends on it. */
const TOKEN_RENEW_MARGIN_MS = 90_000;

const USAGE = `Reemoat client — drive the daemon from a terminal

  list                             every session the daemon owns
  agents                           which agents are installed, and signed in
  agents recheck <agent>           forget that one refused to start, and ask again
  agentauth [<agent>]              where each agent's credentials go, and whether
                                   they are set
  agentauth <agent> --set <env> [token]
                                   store one; prompts when no token is given
  agentauth <agent> --clear <env>  remove one
  dirs [path]                      browse the server's filesystem
  mkdir <parent> <name>            create one directory under it
  new --agent <id> [--cwd <path>]  create a session, then attach
                                   without --cwd, pick the directory interactively
  attach <id> [--since N]          stream a session, answering permissions
  prompt <id> <text>               send a prompt
  config <id>                      the agent's own controls and their values
  config <id> <optionId> <value>   change one
  config <id> --mode <modeId>      change the permission/plan mode
  allow <id> <permId> [optionId]   approve a pending permission
  deny <id> <permId>               refuse a pending permission
  elicit <id> <qId> <k>=<v>...     answer a question the agent asked
  elicit <id> <qId> --decline      skip it; the agent's turn carries on
  elicit <id> <qId> --cancel       abandon the tool call that asked
  title <id> [text]                name a session; no text clears it
  pin <id> | unpin <id>            keep it at the top of the list
  resume <id>                      reattach an agent to a session that ended
  cancel <id>                      stop the turn in flight; the session stays up
  stop <id>                        terminate the agent

  changes <id> [--base head]       what this session added, changed and deleted
  diff <id> <path>                 a unified diff for one file, on stdout
  workspace <id>                   where the session runs, and what is in it
  rmworkspace <id> [--force]       remove the worktree; refuses if it holds work

  plugins                          what is installed, and what each may reach
  plugin install <archive>         install or update one; a .tar.gz or a .zip.
                                   The same verb for both — the manifest says which
  plugin remove <id>               uninstall it, and everything it kept
  plugin enable <id> | disable <id>
                                   switch one off without losing its data
  plugin view <id> [screen|settings]
                                   what one of its screens would draw, as JSON

  --json                           attach emits {seq,ts,event} NDJSON on stdout
  --prompt <text>                  with new: send this once the session is up
  --worktree | --no-worktree       with new: override the daemon's default
  --branch <name>                  with new: name the session's branch
  --mode <id>                      with config: set the mode rather than an option
  --set <env> | --clear <env>      with agentauth: which credential to write
  --ignored                        with changes: include gitignored files
  --delete-branch                  with rmworkspace: delete the branch too

  REEMOAT_URL    ${BASE_URL}
  REEMOAT_TOKEN  ${STATIC_TOKEN ? "(set)" : "(NOT SET)"}

  Or, against a control plane — the URL is learned from it and the short-lived
  token is renewed automatically, including across an expiry mid-stream:
  REEMOAT_CP_URL   ${CP_URL || "(not set)"}
  REEMOAT_CP_KEY   ${CP_KEY ? "(set)" : "(not set)"}
  REEMOAT_MACHINE  ${MACHINE || "(not set)"}

  A control plane is still where the token comes from, and REEMOAT_URL is where
  the request goes: a daemon on this computer. A *remote* machine is reachable
  only over an encrypted channel, which needs a device key this tool does not
  have and the Reemoat app does — so for another machine, use the app.
`;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let cachedToken: string | null = null;
let cachedExpiry = 0;

async function currentToken(force = false): Promise<string> {
  if (!CP_MODE) return STATIC_TOKEN;
  if (!force && cachedToken !== null && Date.now() < cachedExpiry - TOKEN_RENEW_MARGIN_MS) {
    return cachedToken;
  }

  let response: Response;
  try {
    response = await fetch(new URL("/v1/tokens", CP_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${CP_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: MACHINE }),
    });
  } catch (error) {
    if (cachedToken !== null) {
      warn(`!! could not reach the control plane (${describe(error)}); using the token already held`);
      return cachedToken;
    }
    fail(`could not reach the control plane at ${CP_URL}: ${describe(error)}`);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`the control plane refused to issue a token: ${describeError(response.status, body)}`);
  }

  const issued = body as {
    token: string;
    expiresAt: number;
    machine?: { relayUrl?: string | null; relayOnline?: boolean };
  };
  cachedToken = issued.token;
  cachedExpiry = issued.expiresAt;
  if (process.env["REEMOAT_URL"] === undefined) {
    routes = {
      relay: issued.machine?.relayOnline === true ? (issued.machine.relayUrl ?? null) : null,
      relayConfigured: (issued.machine?.relayUrl ?? null) !== null,
    };
  }
  return cachedToken;
}

// Only feeds the no-route message: relay is null with no relay or no tunnel, and relayConfigured tells those apart.
let routes: { relay: string | null; relayConfigured: boolean } = {
  relay: null,
  relayConfigured: false,
};

let chosenRoute: string | null = null;

/** Not called on an HTTP error: the daemon answered, and re-probing would turn every application failure into a flap. */
function forgetRoute(): void {
  if (process.env["REEMOAT_URL"] !== undefined) return;
  chosenRoute = null;
}

async function resolveRoute(): Promise<string> {
  const route = await tryResolveRoute();
  if (route !== null) return route;
  fail(noRouteMessage());
}

/** Null instead of exiting, so the attach loop can back off rather than kill a client holding a transcript. */
async function tryResolveRoute(): Promise<string | null> {
  if (chosenRoute !== null) return chosenRoute;
  if (process.env["REEMOAT_URL"] !== undefined) return (chosenRoute = BASE_URL);
  if (!CP_MODE) return (chosenRoute = BASE_URL);

  // No relay arm: the relay carries only device-bound encrypted channels, and this client holds no device key.
  await currentToken();
  return null;
}

function noRouteMessage(): string {
  if (!routes.relayConfigured) {
    return `no route to ${MACHINE}: the control plane runs no relay, so nothing can reach it`;
  }
  if (routes.relay === null) {
    return `no route to ${MACHINE}: it has no tunnel connected to the relay`;
  }
  return (
    `no route to ${MACHINE}: its relay carries encrypted channels only, and this client holds no ` +
    `device key to open one. Use the Reemoat app for a remote machine, or set REEMOAT_URL to a ` +
    `daemon on this computer`
  );
}

/** firstAttempt guards both retries, an expired token and a dead route: neither may re-enter twice. */
async function api<T>(path: string, init: RequestInit = {}, firstAttempt = true): Promise<T> {
  const base = await resolveRoute();
  const headers: Record<string, string> = { authorization: `Bearer ${await currentToken()}` };
  for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
    headers[key.toLowerCase()] = value;
  }
  if (init.body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, base), { ...init, headers });
  } catch (error) {
    if (firstAttempt && process.env["REEMOAT_URL"] === undefined) {
      forgetRoute();
      if ((await resolveRoute()) !== base) return api<T>(path, init, false);
    }
    throw error;
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    // One retry with a fresh token: a drifted clock should cost a round trip, not the command.
    const code = (body as { error?: { code?: string } } | null)?.error?.code;
    if (firstAttempt && CP_MODE && response.status === 401 && code === "token_expired") {
      await currentToken(true);
      return api<T>(path, init, false);
    }
    throw new ApiError(response.status, body, describeError(response.status, body));
  }
  return body as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeError(status: number, body: unknown): string {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
  if (error?.message) return `${status} ${error.code ?? ""}: ${error.message}`.trim();
  return `${status}`;
}

function warn(line = ""): void {
  process.stderr.write(`${line}\n`);
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  warn(`\n!! ${message}`);
  process.exit(1);
}

let rlInstance: Interface | null = null;
/** Mirrors the private findManifestRoot in src/plugins/host.ts: plugin.json at the top or inside exactly one folder, nothing deeper. */
async function manifestRoot(tree: string): Promise<string | null> {
  const there = async (at: string): Promise<boolean> => {
    try {
      return (await stat(join(at, "plugin.json"))).isFile();
    } catch {
      return false;
    }
  };
  if (await there(tree)) return tree;
  const top = await readdir(tree, { withFileTypes: true });
  const only = top.length === 1 && top[0]?.isDirectory() === true ? top[0].name : null;
  if (only === null) return null;
  const nested = join(tree, only);
  return (await there(nested)) ? nested : null;
}

function rl(): Interface {
  rlInstance ??= createInterface({ input: process.stdin, output: process.stderr });
  return rlInstance;
}

function closeReadline(): void {
  rlInstance?.close();
  rlInstance = null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function describeSession(session: SessionSnapshot): string {
  const parts = [
    session.pinned ? "*" : " ",
    session.id,
    session.agent.padEnd(6),
    session.status.padEnd(11),
    `seq ${session.lastSeq}`,
  ];
  if (session.turn !== null) parts.push(`turn ${session.turn}`);
  // size 0 means occupancy without a window; never divide by it.
  const usage = session.contextUsage;
  if (usage !== null && usage.size > 0) {
    parts.push(`ctx ${Math.round((usage.used / usage.size) * 100)}%`);
  }
  parts.push(session.title ?? session.cwd);
  return parts.join("  ");
}

interface AgentAuthListing {
  loginSupported: boolean;
  agents: (AgentAvailability & {
    credentials: { envName: string; set: boolean; updatedAt: number | null }[];
    login?: { supported: boolean; needsInput: boolean; blocked?: string | null };
  })[];
}

type ListedAgent = AgentAvailability & {
  login?: { supported: boolean; needsInput: boolean; blocked?: string | null };
};

function describeAgent(agent: ListedAgent): string {
  // The same ladder as the browser's agentStance, in the same order; here the words stay where the browser's badge is null (Q3.509).
  const [mark, state] = !agent.available
    ? ["✗", "not installed"]
    : agent.lastStartRefusal != null
      ? ["⚠", "would not start"]
      : agent.login?.blocked === "no_flow"
        ? ["✓", "no sign-in needed"]
        : agent.loggedIn === true
          ? ["✓", "signed in"]
          : agent.loggedIn === false
            ? ["⚠", "not signed in"]
            : ["?", "cannot check"];
  return `${mark} ${agent.id.padEnd(8)} ${agent.displayName.padEnd(18)} ${state}`;
}

/** Read from the snapshot, never the transcript: a restored session may have nothing in the log to fold. */
function printAgentConfig(session: SessionSnapshot): void {
  const options = session.agentConfig.options;
  if (options.length === 0) {
    warn("this agent publishes no controls");
    return;
  }
  for (const option of options) {
    out(`${option.id.padEnd(14)} ${String(option.value).padEnd(14)} [${option.category ?? "-"}]  ${option.name}`);
    for (const choice of option.choices) {
      out(`   ${choice.value === option.value ? "*" : " "} ${choice.value.padEnd(16)} ${choice.name}`);
    }
  }
}

/** true and false become booleans; a select whose choice value is literally true would be misread. */
function configValue(raw: string): string | boolean {
  return raw === "true" ? true : raw === "false" ? false : raw;
}

function describePending(pending: PendingPermissionSnapshot): string {
  const waited = Math.round((Date.now() - pending.raisedAt) / 1000);
  return `${pending.permissionId}  ${pending.title}  (waiting ${waited}s)`;
}

function clip(value: string, max = TEXT_PREVIEW): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function describeEvent(event: SessionEvent): string {
  switch (event.type) {
    case "session_started":
      return `session_started  ${event.agent}  ${event.agentInfo?.name ?? "?"}`;
    case "agent_config": {
      const knobs = event.options.map(
        (option) => `${option.id}=${String(option.value)}${option.category ? ` (${option.category})` : ""}`,
      );
      return `config  ${knobs.length === 0 ? "none" : knobs.join("  ")}`;
    }
    case "prompt":
      return `prompt  ${clip(event.text)}`;
    case "status":
      return `status  ${event.status}${event.exit ? `  (${event.exit.reason})` : ""}`;
    case "workspace": {
      const where =
        event.mode === "worktree"
          ? `worktree  ${event.branch ?? "?"}  ${event.root}`
          : `plain  ${event.root}${event.plainReason ? `  (${event.plainReason})` : ""}`;
      const warnings = event.warnings.map((warning) => `\n     !! ${warning.message}`).join("");
      return `workspace  ${where}${warnings}`;
    }
    case "tool_call":
      return `tool  ${event.title}  [${event.status}]`;
    case "tool_call_update":
      return `tool  ${event.title ?? ""}  [${event.status ?? "?"}]`;
    case "file_change":
      return `file  ${event.path}  (${event.source})`;
    case "permission_request":
      return `PERMISSION  ${event.permissionId ?? "-"}  ${event.title}`;
    case "permission_resolved":
      return `resolved  ${event.permissionId}  ${event.outcome}${
        event.optionId ? ` ${event.optionId}` : ""
      }  by ${event.by}`;
    case "elicitation_request":
      return `QUESTION  ${event.elicitationId}  ${clip(event.message)}`;
    case "elicitation_resolved":
      return `answered  ${event.elicitationId}  ${event.action}${
        event.answers === null || event.answers.length === 0
          ? ""
          : `  ${event.answers.map((answer) => `${answer.label}: ${answer.value}`).join("  ")}`
      }  by ${event.by}`;
    case "plan":
      return `plan  ${event.entries.length} entries`;
    case "turn_end":
      return `turn_end  ${event.stopReason}`;
    case "agent_log":
      return `log  ${clip(event.line, 160)}`;
    case "context_cleared":
      return "context cleared — the agent has forgotten everything above";
    case "other":
      return `other  ${event.sessionUpdate}`;
    case "error":
      return `ERROR  ${event.message}`;
    case "text":
      return `${event.thought ? "thought" : "text"}  ${clip(event.text)}`;
  }
}

class TextRun {
  private buffer = "";
  private firstSeq = 0;
  private thought = false;

  add(seq: number, text: string, thought: boolean): void {
    if (this.buffer.length > 0 && this.thought !== thought) this.flush();
    if (this.buffer.length === 0) {
      this.firstSeq = seq;
      this.thought = thought;
    }
    this.buffer += text;
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const label = this.thought ? "thought" : "text";
    warn(`#${this.firstSeq} ${label}  ${clip(this.buffer, 2_000)}`);
    this.buffer = "";
  }
}

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  entries: number | null;
}
interface DirListing {
  path: string | null;
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

async function pickDirectory(): Promise<string> {
  let path: string | null = null;
  const recent = await api<{ roots: string[]; recent: string[] }>("/fs/roots");

  if (recent.recent.length > 0) {
    warn("recently used:");
    recent.recent.forEach((dir, index) => warn(`  r${index + 1}) ${dir}`));
  }

  for (;;) {
    const query: string = path === null ? "" : `?path=${encodeURIComponent(path)}`;
    const listing: DirListing = await api<DirListing>(`/fs/list${query}`);

    warn(`\n${listing.path ?? "roots"}`);
    if (listing.parent) warn("   ..) up");
    listing.entries.forEach((entry, index) => {
      const count = entry.entries === null ? "?" : String(entry.entries);
      warn(`  ${String(index + 1).padStart(3)}) ${entry.name}${entry.isGitRepo ? "  [git]" : ""}  (${count})`);
    });
    if (listing.entries.length === 0) warn("   (no subdirectories)");

    const hint = listing.path ? "number, .. , Enter to use this directory, q to quit" : "number, q to quit";
    const answer = (await rl().question(`select [${hint}]> `)).trim();

    if (answer === "q") fail("cancelled");
    if (answer === "" && listing.path) return listing.path;
    if (answer === ".." && listing.parent) {
      path = listing.parent;
      continue;
    }
    if (/^r\d+$/.test(answer)) {
      const chosen = recent.recent[Number(answer.slice(1)) - 1];
      if (chosen) return chosen;
      warn("no such recent directory");
      continue;
    }
    if (/^\d+$/.test(answer)) {
      const chosen = listing.entries[Number(answer) - 1];
      if (chosen) {
        path = chosen.path;
        continue;
      }
      warn("no such entry");
      continue;
    }
    if (answer.length > 0) {
      path = answer;
      continue;
    }
    warn("pick a number, or Enter to use the current directory");
  }
}

interface AttachOptions {
  since: number;
  json: boolean;
}

async function attach(sessionId: string, options: AttachOptions): Promise<void> {
  let lastSeq = options.since;
  let instanceId: string | null = null;
  let attempt = 0;
  let stop = false;
  let latest: SessionSnapshot | null = null;

  /** Shared by snapshot and caught_up: a session that ended before attaching is only visible in the hello frame. */
  const reportIfEnded = (session: SessionSnapshot): boolean => {
    if (
      session.status !== "exited" &&
      session.status !== "failed" &&
      session.status !== "interrupted" &&
      session.status !== "parked"
    ) {
      return false;
    }
    if (stop) return false;

    // Parked: nothing reconnects this until a prompt arrives, so say what brings it back and keep the socket.
    if (session.exit?.reason === "parked") {
      warn("\n── the agent was released after a quiet spell; the conversation is intact");
      warn(`   send a message and it comes back:  pnpm client prompt ${session.id} "…"   (^C to stop waiting)`);
      return false;
    }

    // endedWithDaemon, never the status word: a graceful restart arrives as exited, and the daemon is bringing the agent back.
    if (endedWithDaemon(session.exit) && session.resume?.state !== "failed") {
      warn("\n── the daemon went away; staying attached while it reconnects the agent");
      warn(`   if it does not come back:  pnpm client resume ${session.id}   (^C to stop waiting)`);
      return false;
    }

    warn(`\n── session ${session.status}${session.exit ? `: ${session.exit.reason}` : ""}`);
    if (session.resume?.state === "failed") {
      warn(`   could not reattach an agent: ${session.resume.error?.message ?? "unknown"}`);
    }
    if (session.agentSessionId !== null) {
      warn(`   resume it with:  pnpm client resume ${session.id}`);
    }
    stop = true;
    return true;
  };

  const answered = new Set<string>();
  let answering = false;

  const answerNext = async (pending: PendingPermissionSnapshot[]): Promise<void> => {
    if (answering) return;
    const next = pending.find((entry) => !answered.has(entry.permissionId));
    if (!next) return;
    answering = true;
    try {
      warn(`\n⚠  BLOCKED — ${next.title}`);
      next.options.forEach((option, index) => {
        warn(`   ${index + 1}) ${option.name}   [${option.kind}]`);
      });
      warn("   c) cancel      s) skip, leave it pending");
      const choice = (await rl().question("   choose> ")).trim();

      if (choice === "s" || choice === "") {
        warn("   left pending — any client can still answer it");
        answered.add(next.permissionId);
        return;
      }
      const body =
        choice === "c"
          ? { cancel: true }
          : { optionId: next.options[Number(choice) - 1]?.optionId ?? choice };

      const result = await api<{ outcome: string; optionId: string | null; delivered: string }>(
        `/sessions/${sessionId}/permissions/${next.permissionId}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      warn(`   → ${result.outcome} ${result.optionId ?? ""} (${result.delivered})`);
      answered.add(next.permissionId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        warn(`   → already answered elsewhere`);
        answered.add(next.permissionId);
      } else {
        warn(`   → failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      answering = false;
    }
    await answerNext(pending);
  };

  for (;;) {
    const streamToken = await currentToken();
    // tryResolveRoute: nothing answering is a reason to back off, not to exit a client holding a live transcript.
    const base = await tryResolveRoute();
    if (base === null) {
      attempt += 1;
      const wait = Math.round(
        Math.min(RECONNECT_MIN_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS) * (0.8 + Math.random() * 0.4),
      );
      warn(`\n── ${noRouteMessage()}; retrying in ${wait}ms from #${lastSeq}`);
      await sleep(wait);
      continue;
    }
    const url = new URL(`/sessions/${sessionId}/stream`, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(lastSeq));
    url.searchParams.set("token", streamToken);

    const run = new TextRun();
    const closedFor = await new Promise<string>((resolve) => {
      const socket = new WebSocket(url);
      socket.on("open", () => {
        attempt = 0;
      });
      socket.on("error", (error: Error) => resolve(error.message));
      socket.on("close", (code: number, reason: Buffer) =>
        resolve(`closed ${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}`),
      );

      socket.on("message", (data: Buffer) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        switch (frame["type"]) {
          case "hello": {
            const session = frame["session"] as SessionSnapshot;
            const seen = frame["instanceId"] as string;
            // A restart is not fatal: the log and the sequence numbers are on disk, so the cursor still means what it meant.
            if (instanceId !== null && instanceId !== seen) {
              run.flush();
              warn(`\n!! the daemon restarted (${instanceId} → ${seen}); resuming from #${lastSeq}`);
            }
            instanceId = seen;
            latest = session;
            lastSeq = frame["since"] as number;
            warn(`\n── ${describeSession(session)}`);
            warn(`   log ${session.firstSeq}..${session.lastSeq}, resuming after #${lastSeq}`);
            if (frame["gap"] === true) {
              warn(`   !! some history was evicted from the in-memory log`);
            }
            if (session.pendingPermissions.length > 0) {
              warn(`   ⚠  BLOCKED on ${session.pendingPermissions.length} permission(s):`);
              for (const pending of session.pendingPermissions) warn(`      ${describePending(pending)}`);
              void answerNext(session.pendingPermissions);
            }
            return;
          }

          case "events": {
            for (const stored of frame["events"] as StoredEvent[]) {
              if (stored.seq !== lastSeq + 1) {
                run.flush();
                fail(`GAP: expected #${lastSeq + 1}, received #${stored.seq}`);
              }
              lastSeq = stored.seq;

              if (options.json) {
                out(JSON.stringify(stored));
              } else if (stored.event.type === "text") {
                run.add(stored.seq, stored.event.text, stored.event.thought);
                continue;
              } else {
                run.flush();
                warn(`#${stored.seq} ${describeEvent(stored.event)}`);
              }
            }
            return;
          }

          case "lagged": {
            run.flush();
            const from = frame["from"] as number;
            const to = frame["to"] as number;
            // backlog is not a loss: the socket declined to replay past ATTACH_REPLAY_MAX, and every event is still on disk.
            if (frame["reason"] === "backlog") {
              warn(
                `\n-- ${frame["dropped"]} earlier events (seq ${from}..${to}) not replayed on this socket;` +
                  ` they are on the daemon — fetch with GET /sessions/<id>/events?since=${from - 1}`,
              );
            } else {
              warn(`\n!! lost ${frame["dropped"]} events (seq ${from}..${to}) — ${frame["reason"]}`);
            }
            lastSeq = to;
            return;
          }

          case "snapshot": {
            const session = frame["session"] as SessionSnapshot;
            if (session.pendingPermissions.length > 0) void answerNext(session.pendingPermissions);
            latest = session;
            if (reportIfEnded(session)) socket.close(1000, "session ended");
            return;
          }

          case "caught_up":
            run.flush();
            warn(`   caught up at #${frame["seq"]}`);
            if (latest && reportIfEnded(latest)) socket.close(1000, "session ended");
            return;

          default:
            return;
        }
      });
    });

    run.flush();
    if (stop) {
      closeReadline();
      return;
    }

    // 4401 is a scheduled re-authentication: renew and reconnect without backoff. It also bounds revocation for an attached client.
    if (closedFor.startsWith("closed 4401")) {
      await currentToken(true);
      attempt = 0;
      warn(`\n── token expired; renewed, resuming from #${lastSeq}`);
      continue;
    }

    // 4003: the daemon answered, so the route is not implicated; back off to avoid another collapse.
    if (closedFor.startsWith("closed 4003")) {
      attempt = 0;
      warn(`\n── dropped for falling behind; resuming from #${lastSeq} in ${SLOW_CONSUMER_BACKOFF_MS}ms`);
      await sleep(SLOW_CONSUMER_BACKOFF_MS);
      continue;
    }

    // Anything else implicates the route. After the 4401 and 4003 branches, which are the daemon answering.
    forgetRoute();

    attempt += 1;
    const backoff = Math.min(RECONNECT_MIN_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
    warn(`\n── ${closedFor}; reconnecting in ${jittered}ms from #${lastSeq}`);
    await sleep(jittered);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      cwd: { type: "string" },
      prompt: { type: "string" },
      since: { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      mode: { type: "string" },
      set: { type: "string" },
      clear: { type: "string" },
      json: { type: "boolean", default: false },
      ignored: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      decline: { type: "boolean", default: false },
      cancel: { type: "boolean", default: false },
      "delete-branch": { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      "no-worktree": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (!CP_MODE && !STATIC_TOKEN) {
    fail(
      "REEMOAT_TOKEN is not set.\n" +
        "   Either set it, or point this client at a control plane with\n" +
        "   REEMOAT_CP_URL, REEMOAT_CP_KEY and REEMOAT_MACHINE.",
    );
  }
  if (CP_MODE) await currentToken();

  switch (command) {
    case "list": {
      const { sessions } = await api<{ sessions: SessionSnapshot[] }>("/sessions");
      if (sessions.length === 0) {
        warn("no sessions");
        return;
      }
      for (const session of sessions) {
        out(describeSession(session));
        for (const pending of session.pendingPermissions) out(`    ⚠  ${describePending(pending)}`);
      }
      return;
    }

    case "agents": {
      if (positionals[1] === "recheck") {
        const agent = positionals[2];
        if (agent === undefined) fail("usage: agents recheck <agent>");
        const answer = await api<{ agent: string; rechecked: boolean; info?: ListedAgent }>(
          `/agent-auth/${encodeURIComponent(agent)}/recheck`,
          { method: "POST" },
        );
        if (answer.info) out(describeAgent(answer.info));
        else warn(`this machine has no agent called ${answer.agent}`);
        return;
      }
      const { agents } = await api<{ agents: ListedAgent[] }>("/agents");
      for (const agent of agents) {
        out(describeAgent(agent));
        if (agent.hint) out(`    ${agent.hint.split("\n")[0]}`);
      }
      return;
    }

    // Paste-a-token only: the login wizard wants a screen holding the run open, and a printed login code is lost.
    case "agentauth": {
      const agent = positionals[1];
      if (values.set !== undefined && values.clear !== undefined) {
        fail("pass one of --set or --clear, not both");
      }

      if (values.set === undefined && values.clear === undefined) {
        const listing = await api<AgentAuthListing>("/agent-auth");
        if (!listing.loginSupported) {
          warn("!! this daemon's runtime will not drive an agent login — paste a token instead");
        }
        for (const entry of listing.agents) {
          if (agent && entry.id !== agent) continue;
          out(describeAgent(entry));
          if (entry.hint) out(`    ${entry.hint.split("\n")[0]}`);
          for (const slot of entry.credentials) {
            out(`    ${slot.envName.padEnd(26)} ${slot.set ? "set" : "unset"}`);
          }
          if (entry.login !== undefined && !entry.login.supported) {
            // no_flow is not a host limitation: that agent needs no sign-in anywhere.
            out(
              `    ${"login".padEnd(26)} ${
                entry.login.blocked === "no_flow" ? "none needed" : "not available here"
              }`,
            );
          }
        }
        return;
      }

      if (!agent) fail("agentauth --set/--clear requires an agent id");

      if (values.clear !== undefined) {
        const query = new URLSearchParams({ envName: values.clear });
        const result = await api<{ removed: boolean; envName: string }>(
          `/agent-auth/${encodeURIComponent(agent)}?${query}`,
          { method: "DELETE" },
        );
        out(`cleared ${result.envName}`);
        return;
      }

      // Prompted when not given: a token on argv lands in shell history and ps.
      const token = positionals[2] ?? (await rl().question(`${values.set}> `)).trim();
      const result = await api<{ saved: boolean; envName: string }>(
        `/agent-auth/${encodeURIComponent(agent)}`,
        { method: "PUT", body: JSON.stringify({ envName: values.set, token }) },
      );
      out(`saved ${result.envName}`);
      return;
    }

    case "mkdir": {
      const parent = positionals[1];
      const name = positionals[2];
      if (!parent || !name) fail("mkdir requires a parent path and a name");
      // The daemon's resolved path, not parent/name: the join is containment-checked there.
      const created = await api<{ path: string }>("/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ parent, name }),
      });
      out(created.path);
      return;
    }

    case "dirs": {
      const path = positionals[1];
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const listing = await api<DirListing>(`/fs/list${query}`);
      out(listing.path ?? `roots: ${listing.roots.join(", ")}`);
      for (const entry of listing.entries) {
        const count = entry.entries === null ? "?" : String(entry.entries);
        out(`  ${entry.name}${entry.isGitRepo ? "  [git]" : ""}  (${count})  ${entry.path}`);
      }
      return;
    }

    case "new": {
      const agent = values.agent;
      if (!agent) fail("new requires --agent");
      const cwd = values.cwd ?? (await pickDirectory());
      const worktree = values["no-worktree"] ? false : values.worktree ? true : undefined;
      const { session } = await api<{ session: SessionSnapshot }>("/sessions", {
        method: "POST",
        body: JSON.stringify({ agent, cwd, worktree, branch: values.branch }),
      });
      warn(`created ${session.id}  ${session.agent}  ${session.cwd}`);
      if (session.workspace.mode === "worktree") {
        warn(`   worktree on ${session.workspace.git?.branch ?? "?"} from ${session.workspace.requestedCwd}`);
      }
      if (values.prompt) {
        await api(`/sessions/${session.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: values.prompt }),
        });
      }
      await attach(session.id, { since: 0, json: values.json });
      return;
    }

    case "attach": {
      const id = positionals[1];
      if (!id) fail("attach requires a session id");
      const since = values.since === undefined ? 0 : Number.parseInt(values.since, 10);
      if (!Number.isInteger(since) || since < 0) fail(`--since must be a non-negative integer`);
      await attach(id, { since, json: values.json });
      return;
    }

    case "prompt": {
      const id = positionals[1];
      const text = positionals.slice(2).join(" ");
      if (!id || !text) fail("prompt requires a session id and some text");
      try {
        const result = await api<{
          turn?: number | null;
          seq: number;
          cleared?: boolean;
          steered?: boolean;
          queued?: boolean;
          position?: number;
        }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
        out(
          result.cleared === true
            ? `context cleared  seq ${result.seq}`
            : result.queued === true
              ? `queued  ${result.position ?? 0} ahead  seq ${result.seq}`
              : result.steered === true
                ? `steered into turn ${result.turn}  seq ${result.seq}`
                : `accepted  turn ${result.turn}  seq ${result.seq}`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) {
          const limit = (error.body as { error?: { detail?: { limit?: number } } }).error?.detail?.limit;
          warn(limit === undefined ? error.message : `${error.message} (limit ${limit})`);
          process.exit(1);
        }
        if (error instanceof ApiError && error.status === 409) {
          const detail = (error.body as { error?: { detail?: { pendingPermissions?: PendingPermissionSnapshot[] } } })
            .error?.detail;
          warn(error.message);
          for (const pending of detail?.pendingPermissions ?? []) warn(`  ⚠  ${describePending(pending)}`);
          process.exit(1);
        }
        throw error;
      }
      return;
    }

    // Both branches of the config route: configId with a value, and the legacy modeId path the browser never sends.
    case "config": {
      const id = positionals[1];
      if (!id) fail("config requires a session id");
      const optionId = positionals[2];

      if (values.mode === undefined && optionId === undefined) {
        const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}`);
        printAgentConfig(session);
        return;
      }

      let body: Record<string, unknown>;
      if (values.mode !== undefined) {
        body = { modeId: values.mode };
      } else {
        const value = positionals[3];
        if (value === undefined) fail("config requires a value: config <id> <optionId> <value>");
        body = { configId: optionId, value: configValue(value) };
      }

      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}/config`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      printAgentConfig(session);
      return;
    }

    case "allow":
    case "deny": {
      const id = positionals[1];
      const permissionId = positionals[2];
      if (!id || !permissionId) fail(`${command} requires a session id and a permission id`);
      const optionId = positionals[3];
      const body =
        command === "deny"
          ? { decision: "reject" }
          : optionId
            ? { optionId }
            : { decision: "allow" };
      try {
        const result = await api<{ outcome: string; optionId: string | null; delivered: string }>(
          `/sessions/${id}/permissions/${permissionId}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        out(`${result.outcome} ${result.optionId ?? ""} (${result.delivered})`);
      } catch (error) {
        // A repeated answer is a 409 with a success-shaped body; narrowed on repeat, since permission_expired is a real error.
        if (error instanceof ApiError && error.status === 409) {
          const repeated = error.body as
            | { repeat?: boolean; outcome?: string; optionId?: string | null; by?: string }
            | null;
          if (repeated?.repeat === true) {
            out(`${repeated.outcome ?? "answered"} ${repeated.optionId ?? ""} (already answered by ${repeated.by ?? "?"})`);
            return;
          }
        }
        throw error;
      }
      return;
    }

    case "elicit": {
      const id = positionals[1];
      const elicitationId = positionals[2];
      if (!id || !elicitationId) fail("elicit requires a session id and a question id");

      let body: unknown;
      if (values.decline) body = { decline: true };
      else if (values.cancel) body = { cancel: true };
      else {
        const form = await api<{ fields: { key: string; kind: string }[] }>(
          `/sessions/${id}/elicitations/${elicitationId}`,
        );
        const kinds = new Map(form.fields.map((field) => [field.key, field.kind]));
        const content: Record<string, string | number | boolean | string[]> = {};
        for (const pair of positionals.slice(3)) {
          const at = pair.indexOf("=");
          if (at < 0) fail(`expected <key>=<value>, got ${JSON.stringify(pair)}`);
          const key = pair.slice(0, at);
          const raw = pair.slice(at + 1);
          const kind = kinds.get(key);
          if (kind === undefined) fail(`this form has no field ${JSON.stringify(key)}`);
          if (kind === "multi_select") {
            const held = content[key];
            content[key] = Array.isArray(held) ? [...held, raw] : [raw];
          } else if (kind === "number" || kind === "integer") {
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) fail(`${key} expects a number, got ${JSON.stringify(raw)}`);
            content[key] = parsed;
          } else if (kind === "boolean") {
            content[key] = raw === "true" || raw === "1";
          } else {
            content[key] = raw;
          }
        }
        body = { content };
      }

      try {
        const result = await api<{ action: string; delivered: string }>(
          `/sessions/${id}/elicitations/${elicitationId}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        out(`${result.action} (${result.delivered})`);
      } catch (error) {
        // A 409 with repeat is success here too; elicitation_expired is also a 409 and is an error.
        if (error instanceof ApiError && error.status === 409) {
          const repeated = error.body as { repeat?: boolean; action?: string; by?: string } | null;
          if (repeated?.repeat === true) {
            out(`${repeated.action ?? "answered"} (already answered by ${repeated.by ?? "?"})`);
            return;
          }
        }
        throw error;
      }
      return;
    }

    case "changes": {
      const id = positionals[1];
      if (!id) fail("changes requires a session id");
      const query = new URLSearchParams();
      if (values.base) query.set("base", values.base);
      if (values.ignored) query.set("ignored", "1");
      const set = await api<ChangeSet>(`/sessions/${id}/changes?${query}`);
      if (!set.supported) {
        warn(`not a git repository (${set.reason})`);
        return;
      }
      if (set.files.length === 0) warn(`no changes against ${set.base.slice(0, 8)}`);
      for (const file of set.files) {
        const counts = file.added === null ? "" : `  +${file.added} -${file.deleted ?? 0}`;
        const flags = [file.binary ? "binary" : "", file.symlink ? "symlink" : "", file.collapsed ? "dir" : ""]
          .filter(Boolean)
          .join(",");
        out(
          `${file.status.padEnd(12)} ${file.path}` +
            (file.oldPath ? ` ← ${file.oldPath}` : "") +
            counts +
            (flags ? `  [${flags}]` : ""),
        );
      }
      if (set.truncated) {
        warn(`!! truncated (${set.truncated.reason}, limit ${set.truncated.limit}) of ${set.total ?? "?"} total`);
      }
      return;
    }

    case "diff": {
      const id = positionals[1];
      const path = positionals[2];
      if (!id || !path) fail("diff requires a session id and a path");
      const query = new URLSearchParams({ path });
      if (values.base) query.set("base", values.base);
      const diff = await api<DiffResult>(`/sessions/${id}/changes/diff?${query}`);
      // Header to stderr, patch to stdout, so piping into git apply works.
      warn(`── ${diff.status}  ${diff.path}${diff.oldPath ? ` ← ${diff.oldPath}` : ""}  vs ${diff.base.slice(0, 8)}`);
      if (diff.kind === "symlink") {
        warn(`   symlink → ${diff.symlinkTarget ?? "?"} (never followed)`);
        return;
      }
      if (diff.kind === "binary") {
        warn(`   binary, ${diff.bytes} bytes — not shown`);
        return;
      }
      if (diff.patch) out(diff.patch.replace(/\n$/, ""));
      if (diff.truncated) warn(`!! truncated at ${diff.bytes} bytes`);
      return;
    }

    case "workspace": {
      const id = positionals[1];
      if (!id) fail("workspace requires a session id");
      const { status } = await api<{ status: WorkspaceStatus }>(`/sessions/${id}/workspace`);
      out(`${status.mode}  ${status.root}`);
      if (status.branch) out(`branch    ${status.branch}`);
      if (status.baseCommit) out(`base      ${status.baseCommit.slice(0, 12)}`);
      // ? for null: a probe that timed out is not the same claim as a worktree git has forgotten.
      const tri = (value: boolean | null): string => (value === null ? "?" : String(value));
      out(`exists    ${tri(status.exists)}   registered ${tri(status.registered)}   locked ${status.locked}`);
      if (status.dirty) {
        out(`dirty     ${status.dirty.tracked} tracked, ${status.dirty.untracked} untracked`);
      }
      if (status.commitsAhead !== null) out(`commits   ${status.commitsAhead} since base`);
      out(`unpushed  ${status.hasRemote ? String(status.unpushed) : "(no remote)"}`);
      return;
    }

    case "plugins": {
      const { plugins, api: apiVersion } = await api<{ plugins: PluginSummary[]; api: number }>("/plugins");
      if (plugins.length === 0) {
        out(`no plugins installed  (this daemon speaks plugin API ${apiVersion})`);
        return;
      }
      for (const plugin of plugins) {
        const state = plugin.enabled ? plugin.state : "off";
        out(`${plugin.id.padEnd(20)} ${plugin.version.padEnd(10)} ${state.padEnd(9)} ${plugin.name}`);
        if (plugin.scopes.length > 0) out(`  scopes  ${plugin.scopes.join(", ")}`);
        if (plugin.net.length > 0) out(`  net     ${plugin.net.join(", ")}`);
        if (plugin.failure !== null) warn(`  !! ${plugin.failure}`);
      }
      return;
    }

    case "plugin": {
      const action = positionals[1];
      const id = positionals[2];

      if (action === "install") {
        if (!id) fail("plugin install requires a path to a .tar.gz or a .zip");
        // Sent whole, not streamed: a streamed fetch body needs half duplex and fails differently through a relay.
        const bytes = readFileSync(id);

        // The manifest is read locally, with the daemon's own unpacker, before anything is sent: consent precedes the upload.
        const staging = await mkdtemp(join(tmpdir(), "reemoat-plugin-peek-"));
        let declared: PluginManifest | null = null;
        try {
          const unpacked = await unpackArchive({
            staging,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
              },
            }),
            limits: PLUGIN_LIMITS,
          });
          if (unpacked.kind === "ok") {
            const found = await manifestRoot(unpacked.tree);
            if (found !== null) {
              const parsed = parseManifest(await readFile(join(found, "plugin.json"), "utf8"));
              if (parsed.ok) declared = parsed.manifest;
            }
          }
        } catch {
          // Unreadable here is not a refusal: the daemon is the authority, and the prompt below says nothing could be read.
        } finally {
          await rm(staging, { recursive: true, force: true });
        }

        if (declared === null) {
          warn(`could not read ${basename(id)} here, so nobody can say what it asks for`);
        } else {
          out(`${declared.name} ${declared.version}  (${declared.id})`);
          if (declared.description !== null) out(`  ${declared.description}`);
          out(`  it may:  ${declared.scopes.length > 0 ? declared.scopes.join(", ") : "(nothing)"}`);
          if (declared.net.length > 0) out(`  reach:   ${declared.net.join(", ")}`);
          // Hooks beside the scopes: a hooks-only plugin asks for no scopes yet is told about every session.
          if (declared.contributes.hooks.length > 0) out(`  told of: ${declared.contributes.hooks.join(", ")}`);
          for (const line of addedLines(declared)) out(`  adds:    ${line}`);
        }

        // Asked only on a TTY: a blocking prompt would break scripted installs; --yes says the same on purpose.
        if (!values.yes && process.stdin.isTTY === true) {
          const said = (await rl().question("install it? [y/N]> ")).trim().toLowerCase();
          if (said !== "y" && said !== "yes") {
            out("nothing was sent");
            return;
          }
        }

        const answer = await api<{ plugin: PluginSummary; replaced: string | null }>(
          `/plugins?name=${encodeURIComponent(basename(id))}`,
          { method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" } },
        );
        const { plugin, replaced } = answer;
        out(
          replaced === null
            ? `installed  ${plugin.id} ${plugin.version}`
            : `updated    ${plugin.id} ${replaced} -> ${plugin.version}`,
        );
        if (plugin.state === "failed" && plugin.failure !== null) warn(`  !! ${plugin.failure}`);
        return;
      }

      if (action === "remove") {
        if (!id) fail("plugin remove requires a plugin id");
        // Read removed: the route is replayable and answers 200 either way.
        const { removed } = await api<{ removed: boolean }>(`/plugins/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        out(removed ? `removed  ${id}  (and everything it kept)` : `not installed  ${id}  (nothing to remove)`);
        return;
      }

      if (action === "enable" || action === "disable") {
        if (!id) fail(`plugin ${action} requires a plugin id`);
        const { plugin } = await api<{ plugin: PluginSummary }>(`/plugins/${encodeURIComponent(id)}/state`, {
          method: "POST",
          body: JSON.stringify({ enabled: action === "enable" }),
        });
        out(`${plugin.id}  ${plugin.enabled ? plugin.state : "off"}`);
        return;
      }

      if (action === "view") {
        if (!id) fail("plugin view requires a plugin id");
        const which = positionals[3] === "settings" ? "settings" : "screen";
        const { result } = await api<{ result: unknown }>(
          `/plugins/${encodeURIComponent(id)}/views/${which}`,
        );
        out(JSON.stringify(result, null, 2));
        return;
      }

      fail("plugin takes install, remove, enable, disable or view");
    }

    case "rmworkspace": {
      const id = positionals[1];
      if (!id) fail("rmworkspace requires a session id");
      const query = new URLSearchParams();
      if (values.force) query.set("force", "1");
      if (values["delete-branch"]) query.set("deleteBranch", "1");
      try {
        const result = await api<{ branchDeleted: boolean; pruned: boolean; warnings: string[] }>(
          `/sessions/${id}/workspace?${query}`,
          { method: "DELETE" },
        );
        out(`removed  branch_deleted=${result.branchDeleted}  pruned=${result.pruned}`);
        for (const warning of result.warnings) warn(`!! ${warning}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          warn(`refused: ${error.message}`);
          // Suggest --force only for workspace_dirty: for the other 409s it would send the user round a loop.
          const code = (error.body as { error?: { code?: string } } | null)?.error?.code;
          if (code === "workspace_dirty") warn(`   pass --force to remove it anyway`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      return;
    }

    case "title": {
      const id = positionals[1];
      if (!id) fail("title requires a session id");
      const text = positionals.slice(2).join(" ");
      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}/meta`, {
        method: "POST",
        body: JSON.stringify({ title: text.length === 0 ? null : text }),
      });
      // The daemon's value, not the argument: a title is normalized on the way in.
      out(session.title ?? "(cleared)");
      return;
    }

    case "pin":
    case "unpin": {
      const id = positionals[1];
      if (!id) fail(`${command} requires a session id`);
      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}/meta`, {
        method: "POST",
        body: JSON.stringify({ pinned: command === "pin" }),
      });
      out(`${session.id} ${session.pinned ? "pinned" : "unpinned"}`);
      return;
    }

    case "resume": {
      const id = positionals[1];
      if (!id) fail("resume requires a session id");
      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}/resume`, {
        method: "POST",
        body: "{}",
      });
      out(`${session.id} ${session.status}  agent session ${session.agentSessionId ?? "(none)"}`);
      warn(`   the transcript continues at #${session.lastSeq}`);
      return;
    }

    // Stops the turn, not the session: stop kills the agent, this leaves both where they were.
    case "cancel": {
      const id = positionals[1];
      if (!id) fail("cancel requires a session id");
      const answer = await api<{
        cancelled: boolean;
        turn: number | null;
        settled: boolean;
        session: SessionSnapshot;
      }>(`/sessions/${id}/cancel`, { method: "POST", body: "{}" });
      out(
        answer.cancelled
          ? `${answer.session.id} ${answer.session.status}  turn ${answer.turn} cancelled`
          : `${answer.session.id} ${answer.session.status}  nothing was running`,
      );
      if (answer.cancelled && !answer.settled) {
        warn("   the agent has not finished yet — the turn ends into the transcript when it does");
      }
      return;
    }

    case "stop": {
      const id = positionals[1];
      if (!id) fail("stop requires a session id");
      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}`, {
        method: "DELETE",
      });
      out(
        `${session.id} ${session.status}` +
          (session.exit ? `  ${session.exit.reason}  confirmed_dead=${session.exit.agentConfirmedDead}` : ""),
      );
      return;
    }

    default:
      fail(`unknown command "${command}" — run with --help`);
  }
}

process.on("SIGINT", () => {
  closeReadline();
  process.exit(130);
});

main().then(
  () => {
    closeReadline();
  },
  (error: unknown) => {
    closeReadline();
    if (error instanceof ApiError) fail(error.message);
    warn(`\n!! ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
