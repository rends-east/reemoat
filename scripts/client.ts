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
// Imported rather than hand-declared at the call site, which is what it used to
// be and how it fell a field behind: `loggedIn` was added to the daemon's answer
// and this client kept printing a ✓ for an agent that is installed and signed
// out. `packages/web` has to mirror these by hand — it cannot reach across the
// package boundary — but this file can, so a drift that is invisible there is a
// type error here.
import type { AgentAvailability } from "../src/runtime/types.js";
import { PLUGIN_LIMITS, unpackArchive } from "../src/archive.js";
import { parseManifest } from "../src/plugins/manifest.js";
import type { PluginManifest, PluginSummary } from "../src/plugins/protocol.js";
import type { WorkspaceStatus } from "../src/worktree.js";

const STATIC_TOKEN = process.env["REEMOAT_TOKEN"] ?? "";

/**
 * Control-plane mode.
 *
 * All three set, and this client asks the control plane for a short-lived token
 * for one machine, learns that machine's URL from the same answer, and renews
 * before it expires. None of them set, and it behaves exactly as it always did:
 * one long-lived `REEMOAT_TOKEN` against one `REEMOAT_URL`.
 */
const CP_URL = (process.env["REEMOAT_CP_URL"] ?? "").trim();
const CP_KEY = (process.env["REEMOAT_CP_KEY"] ?? "").trim();
const MACHINE = (process.env["REEMOAT_MACHINE"] ?? "").trim();
const CP_MODE = CP_URL.length > 0 && CP_KEY.length > 0 && MACHINE.length > 0;

// 7887 matches the daemon's own default. See `DEFAULT_PORT` in scripts/daemon.ts.
const BASE_URL = process.env["REEMOAT_URL"] ?? "http://127.0.0.1:7887";

/*
 * `REEMOAT_ROUTE` is gone, along with the choice it pinned.
 *
 * It selected between a direct URL and the relay, which was a real decision while
 * both existed. Against a control plane there is one path now — the tunnel the
 * daemon dialled out — and without one there is `REEMOAT_URL` on loopback. A
 * value left in an environment is warned about rather than ignored.
 */
if ((process.env["REEMOAT_ROUTE"] ?? "").trim().length > 0) {
  warn("!! REEMOAT_ROUTE is set and no longer does anything: the relay is the only path");
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/**
 * After a `4003`: the daemon threw away queued events because we could not keep
 * up. Reconnecting immediately earns a second collapse, and the same number lives
 * in `packages/web/src/stream.ts` for the same reason.
 */
const SLOW_CONSUMER_BACKOFF_MS = 5_000;
const TEXT_PREVIEW = 400;
/**
 * Renew once this much of the token's life is left.
 *
 * Larger than the daemon's 60s clock leeway, so a renewal never depends on that
 * leeway having been the thing keeping the previous token alive.
 */
const TOKEN_RENEW_MARGIN_MS = 90_000;

const USAGE = `Reemoat client — drive the daemon from a terminal

  list                             every session the daemon owns
  agents                           which agents are installed, and signed in
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

  Against a control plane every request goes through its relay: daemons bind
  loopback and the registry records no address for them, so the tunnel is the
  only way in. Without one, REEMOAT_URL is a daemon on this machine.
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

/**
 * The bearer to present, minting or renewing one if this is control-plane mode.
 *
 * In static mode this is just the environment variable, so nothing about the
 * old single-machine flow changes.
 */
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
    // Worth naming, because it is the one outage that does not stop a session:
    // the daemon and the agent are fine, only issuance is down.
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
  // The registry's whole job on this path: tell the client where the machine is.
  // An explicit REEMOAT_URL still wins, so a tunnel or an override stays usable.
  if (process.env["REEMOAT_URL"] === undefined) {
    routes = {
      relay: issued.machine?.relayOnline === true ? (issued.machine.relayUrl ?? null) : null,
      relayConfigured: (issued.machine?.relayUrl ?? null) !== null,
    };
  }
  return cachedToken;
}

/* ------------------------------------------------------------------ *
 * Choosing a route
 * ------------------------------------------------------------------ */

/**
 * Where this machine can be reached, as the control plane last described it.
 *
 * `relay` is null both when there is no relay and when there is one the daemon is
 * not connected to, because for the purpose of reaching it those are now the same
 * thing: there is no second path to try. `relayConfigured` keeps them apart for
 * the error message, which is the one place the difference matters to a human.
 */
let routes: { relay: string | null; relayConfigured: boolean } = {
  relay: null,
  relayConfigured: false,
};

/** How long to wait for a machine to answer before calling it unreachable. */
const PROBE_TIMEOUT_MS = 1_500;

let chosenRoute: string | null = null;

/**
 * Forget what we last believed about reachability, so the next call re-asks.
 *
 * Called when the machine stops answering — a dropped stream, a network error on
 * a request. It used to drop a *route memo* chosen between two candidates; what
 * it drops now is the belief that the machine is up, which is still worth having
 * because a daemon that lost its tunnel comes back the moment it re-dials.
 *
 * Deliberately *not* called on an HTTP error. A 401, a 404 or a 500 means the
 * request arrived and the daemon answered; re-probing there would turn every
 * application-level failure into a flap.
 */
function forgetRoute(): void {
  if (process.env["REEMOAT_URL"] !== undefined) return;
  chosenRoute = null;
}

/**
 * Where to send requests: the relay, or `REEMOAT_URL` when there is no fleet.
 *
 * `/health` is the probe, and it carries the token: the relay authenticates
 * everything including `/health`, and an unauthenticated probe would be a free
 * oracle for which machines in the fleet are online.
 */
async function resolveRoute(): Promise<string> {
  const route = await tryResolveRoute();
  if (route !== null) return route;
  fail(noRouteMessage());
}

/**
 * The same choice, but `null` instead of exiting when nothing answers.
 *
 * The attach loop needs this: a total outage there is a reason to back off and
 * try again, not a reason to kill a client that is holding a session's transcript
 * and its readline. A one-shot command has nothing to wait for, so `resolveRoute`
 * above turns the same `null` into one clear message and an exit.
 */
async function tryResolveRoute(): Promise<string | null> {
  if (chosenRoute !== null) return chosenRoute;
  if (process.env["REEMOAT_URL"] !== undefined) return (chosenRoute = BASE_URL);
  if (!CP_MODE) return (chosenRoute = BASE_URL);

  // Populates `routes` as a side effect of minting.
  const token = await currentToken();

  if (routes.relay !== null && (await probe(routes.relay, token))) {
    return (chosenRoute = routes.relay);
  }
  return null;
}

/**
 * Why there is no route, in the terms an operator can act on.
 *
 * Two distinguishable causes and they point at different things to go and look
 * at: a control plane with no relay is a configuration nobody finished, and a
 * machine with no tunnel is a daemon that is off or cannot dial out.
 */
function noRouteMessage(): string {
  if (!routes.relayConfigured) {
    return `no route to ${MACHINE}: the control plane runs no relay, so nothing can reach it`;
  }
  if (routes.relay === null) {
    return `no route to ${MACHINE}: it has no tunnel connected to the relay`;
  }
  return `no route to ${MACHINE}: its relay did not answer`;
}

async function probe(base: string, token: string | null): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", base), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    // Unreachable, refused, or too slow. All the same answer to the caller.
    return false;
  }
}

/**
 * One request, with at most one retry.
 *
 * `firstAttempt` is the recursion guard for both retries below — an expired
 * token and a route that stopped answering — because both re-enter here and
 * neither may do so twice. One name rather than two, since "have we already
 * retried" is one fact and two flags could disagree about it.
 */
async function api<T>(path: string, init: RequestInit = {}, firstAttempt = true): Promise<T> {
  const base = await resolveRoute();
  const headers: Record<string, string> = { authorization: `Bearer ${await currentToken()}` };
  // The caller's own headers, then the default. JSON is what every verb here
  // sends bar one — `plugin install` posts an archive — and a body whose type is
  // announced wrongly is a lie this client would be telling on every install.
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
    /*
     * The machine stopped answering. Forget that and try once more, which turns
     * a daemon that re-dialled its tunnel a second ago into one slow command
     * rather than a failure.
     *
     * Only when a re-probe could pick something different: with an explicit
     * `REEMOAT_URL` there is nothing to re-resolve, and retrying would just
     * double the time it takes to report the same failure.
     */
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
    // One retry with a freshly minted token. A clock that drifted, or a request
    // that sat behind a slow agent call for longer than the token had left,
    // should cost a round trip rather than the command.
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
/**
 * Where `plugin.json` is, for the disclosure `plugin install` prints before it
 * sends anything.
 *
 * The two shapes the daemon accepts and no others: loose members, or exactly one
 * folder holding them — which is what somebody who compressed a directory
 * produces. Nothing deeper is searched, because nothing deeper is searched
 * on arrival either, and a preview that found a manifest the daemon will not is
 * worse than one that finds none.
 *
 * ⚠ **Restated rather than imported.** `findManifestRoot` is private to
 * `src/plugins/host.ts`, and a preview in a CLI is not a good enough reason for
 * that file to grow a public surface. Seven lines, and the shape it mirrors is
 * named here so the next person changing one finds the other.
 */
async function manifestRoot(tree: string): Promise<string | null> {
  const there = async (at: string): Promise<boolean> => {
    try {
      return (await stat(join(at, "plugin.json"))).isFile();
    } catch {
      // Absent, or a directory wearing the name. Either way there is no manifest
      // at this level, which is the only question being asked.
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
  // Created lazily: an open readline holds stdin, which would stop commands that
  // never ask a question from exiting on their own.
  rlInstance ??= createInterface({ input: process.stdin, output: process.stderr });
  return rlInstance;
}

function closeReadline(): void {
  rlInstance?.close();
  rlInstance = null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function describeSession(session: SessionSnapshot): string {
  const parts = [
    // A pin is a column of its own rather than a suffix, so the list stays aligned
    // whether or not anything is pinned.
    session.pinned ? "*" : " ",
    session.id,
    session.agent.padEnd(6),
    // 11, because "interrupted" is the longest status.
    session.status.padEnd(11),
    `seq ${session.lastSeq}`,
  ];
  if (session.turn !== null) parts.push(`turn ${session.turn}`);
  // Only when the agent actually said. `size` is 0 for "reported occupancy but no
  // window", which is the one value nothing may divide by — printing a percentage
  // there would be inventing the denominator.
  const usage = session.contextUsage;
  if (usage !== null && usage.size > 0) {
    parts.push(`ctx ${Math.round((usage.used / usage.size) * 100)}%`);
  }
  parts.push(session.title ?? session.cwd);
  return parts.join("  ");
}

/**
 * `GET /agent-auth`: availability, plus where each agent's credentials go.
 *
 * The availability half is imported; only this wrapper is declared here, because
 * `server.ts` assembles it inline and it has no exported name. `secret` is not in
 * it and there is no route that returns one — `set` is the whole answer a client
 * gets.
 */
interface AgentAuthListing {
  loginSupported: boolean;
  agents: (AgentAvailability & {
    credentials: { envName: string; set: boolean; updatedAt: number | null }[];
    login?: { supported: boolean; needsInput: boolean };
  })[];
}

/**
 * One agent's line: installed, and signed in — which are two questions.
 *
 * This printed `✓`/`✗` from `available` alone, and `available` only ever meant
 * "the binary is on PATH". An installed but logged-out agent therefore read as
 * ready, and the person found out at `502 agent_auth_required`, after a container
 * start and a worktree. `loggedIn` is `boolean | null` for the same reason
 * {@link import("../src/runtime/types.js").Liveness} has three answers: claude
 * can say non-interactively and kimi cannot, so **`null` must never render as
 * signed out** — that would send somebody to a login they have already done.
 *
 * The hint is printed by the callers whenever there is one, not only when the
 * agent is missing: `container.ts` sets it to the agent's own `authHint` for
 * `loggedIn === false`, which is precisely the case that has something to say.
 */
function describeAgent(agent: AgentAvailability): string {
  const [mark, state] = !agent.available
    ? ["✗", "not installed"]
    : agent.loggedIn === true
      ? ["✓", "signed in"]
      : agent.loggedIn === false
        ? ["⚠", "not signed in"]
        : ["?", "status unknown"];
  return `${mark} ${agent.id.padEnd(8)} ${agent.displayName.padEnd(18)} ${state}`;
}

/**
 * The agent's own controls, as the daemon last saw them.
 *
 * Read from the *snapshot* and never from the transcript, which is the same rule
 * the browser follows: these are state with one current version, and a restored
 * session has no live agent to have published them at all, so there may be nothing
 * in the log to fold. Shared by the read and the write so a `config` that sets
 * something prints it in the same shape it listed it.
 */
function printAgentConfig(session: SessionSnapshot): void {
  const options = session.agentConfig.options;
  if (options.length === 0) {
    warn("this agent publishes no controls");
    return;
  }
  for (const option of options) {
    // The category and not the id is what a reader should key on — the ids are
    // not portable between agents (claude's `effort`, kimi's `thinking`), which
    // is the whole reason `AgentConfigOption` carries one.
    out(`${option.id.padEnd(14)} ${String(option.value).padEnd(14)} [${option.category ?? "-"}]  ${option.name}`);
    for (const choice of option.choices) {
      out(`   ${choice.value === option.value ? "*" : " "} ${choice.value.padEnd(16)} ${choice.name}`);
    }
  }
}

/**
 * `true`/`false` become booleans; everything else stays the string it is.
 *
 * The daemon validates a boolean option against a real boolean and a select
 * against its own choice list, so argv has to be able to express both. A select
 * whose choice value is literally `"true"` would be misread here — no agent
 * publishes one, and the refusal would be the daemon's own `invalid_config_value`
 * rather than silence.
 */
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
      // One line per knob, in the agent's own vocabulary — this is the reference
      // implementation for the browser's picker, so it prints what the picker
      // would draw rather than a summary of it.
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
      // Warnings are printed in full rather than clipped: `dirty_source` is the
      // one line that explains why the agent cannot see work you know you have.
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
      // The answers are already rendered `label: value` pairs — the resolution is
      // self-describing on purpose, so this needs no join back to the request.
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
    // The boundary a clear leaves. Everything above it is still here and still
    // readable; the agent simply no longer knows any of it.
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

/**
 * Joins consecutive text chunks into one paragraph.
 *
 * The agent streams a few words at a time; one line per chunk is unreadable. The
 * seq of the first chunk is kept so the numbering stays visible.
 */
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

/* ------------------------------------------------------------------ *
 * The interactive directory picker
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Attach
 * ------------------------------------------------------------------ */

interface AttachOptions {
  since: number;
  json: boolean;
}

async function attach(sessionId: string, options: AttachOptions): Promise<void> {
  let lastSeq = options.since;
  let instanceId: string | null = null;
  let attempt = 0;
  let stop = false;
  /** The most recent snapshot seen, from either a `hello` or a `snapshot` frame. */
  let latest: SessionSnapshot | null = null;

  /**
   * Reports a session that has ended, and says whether to stop attaching.
   *
   * Shared by `snapshot` and `caught_up` so the two cannot drift: a session that
   * ends *while* we watch arrives as a snapshot, and one that had already ended
   * before we attached is only ever visible in the hello frame.
   */
  const reportIfEnded = (session: SessionSnapshot): boolean => {
    if (session.status !== "exited" && session.status !== "failed" && session.status !== "interrupted") {
      return false;
    }
    if (stop) return false;

    /*
     * A session the daemon ended is one it is bringing back, so **stay
     * attached**.
     *
     * `endedWithDaemon` and never the status word, which is the correction this
     * whole change turns on — and which this function is the place it would
     * silently have been missed, since the three-way `!==` chain above is a
     * hand-rolled copy of `isTerminal` and a graceful restart arrives as
     * `exited`. Imported from `src/events.ts` as a value rather than reimplemented,
     * which is exactly why this file imports from `src/` at all.
     *
     * The socket is already dead here — the daemon's process left — so what
     * actually runs is the reconnect loop below, and when the auto-resume lands
     * the `{type: "status", status: "starting"}` it appends arrives on the very
     * next frame and the transcript simply carries on. That is the property
     * being demonstrated, in the one client that can demonstrate it.
     */
    if (endedWithDaemon(session.exit) && session.resume?.state !== "failed") {
      warn("\n── the daemon went away; staying attached while it reconnects the agent");
      // Said here rather than left implicit, because this branch waits and the
      // one thing it cannot see is whether the daemon is going to do anything:
      // `REEMOAT_AUTO_RESUME=0` produces exactly this state and no reconnection,
      // and a client that sat there silently would look hung rather than patient.
      warn(`   if it does not come back:  pnpm client resume ${session.id}   (^C to stop waiting)`);
      return false;
    }

    warn(`\n── session ${session.status}${session.exit ? `: ${session.exit.reason}` : ""}`);
    if (session.resume?.state === "failed") {
      // The daemon tried and gave up, so nobody is coming — say what it said and
      // let the loop end rather than waiting on a reconnection that will not happen.
      warn(`   could not reattach an agent: ${session.resume.error?.message ?? "unknown"}`);
    }
    // Terminal, but not necessarily over: a session that still holds the agent's
    // own session id can be picked up where it left off.
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
        // Someone else got there first, or this is a retry that already landed.
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
    // Minted per connection, so a reconnect after an expiry close carries a
    // token that is actually valid rather than the one that was just refused.
    const streamToken = await currentToken();
    /*
     * Resolved per connection rather than once, so a reconnect after the direct
     * path died lands on the relay instead of retrying a route that is gone.
     * That only works because the loop below calls `forgetRoute` on every close
     * that is not a token expiry — the memo alone would hand back the dead route
     * for ever.
     *
     * `tryResolveRoute`, not `resolveRoute`: nothing answering right now is a
     * reason to back off, not a reason to exit a client holding a live transcript
     * and a readline. A one-shot command has nothing to wait for and still exits.
     */
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
            // A restart used to be fatal here. It no longer is: the log and the
            // sequence numbers are on disk, so the session comes back as
            // `interrupted` and the cursor we are holding still means what it
            // meant. Worth saying out loud, because the seq continuity across
            // this line is the whole point of the daemon being durable.
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
              // The whole point of the sequence number. If this ever fires, the
              // daemon broke its contract and silence would be worse than noise.
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
            /*
             * **Three reasons, and only two of them are losses.**
             *
             * `backlog` says the *socket* declined to replay this far — the daemon
             * bounds an attach (`ATTACH_REPLAY_MAX`) rather than the history — and
             * every one of those events is still on disk. This printed
             * `!! lost N events … backlog` for it, which is untrue, and `attach`
             * defaults to `--since 0`, so it fired on any session past the cap: a
             * transcript that is completely intact reported as data loss, and
             * `--json` silently emitting only the newest 2000 of it.
             *
             * Fetching the range here would mean a paging loop in what is meant to
             * stay a thin reference client, so it says where the events are instead
             * — and, above all, does not call them lost.
             */
            if (frame["reason"] === "backlog") {
              warn(
                `\n-- ${frame["dropped"]} earlier events (seq ${from}..${to}) not replayed on this socket;` +
                  ` they are on the daemon — fetch with GET /sessions/<id>/events?since=${from - 1}`,
              );
            } else {
              warn(`\n!! lost ${frame["dropped"]} events (seq ${from}..${to}) — ${frame["reason"]}`);
            }
            // Advance past the range rather than asserting on it; the line above is
            // the record of what was skipped and why.
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
            // A session that was already terminal when we attached never changes
            // state again, so no `snapshot` frame is ever coming and waiting for
            // one waits forever. `caught_up` is the right place to notice: it
            // means the backlog is fully delivered, so there is genuinely nothing
            // more to receive. Persistence is what made this the common case —
            // every restored session is terminal from the moment it comes back.
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

    // 4401 is the daemon telling us the token behind this socket has expired.
    // That is a scheduled re-authentication, not a failure: renew immediately
    // and reconnect without backoff, because backing off here would leave the
    // stream dark for no reason. It is also the mechanism that bounds
    // revocation for an attached client, so it must not be treated as noise.
    if (closedFor.startsWith("closed 4401")) {
      await currentToken(true);
      attempt = 0;
      warn(`\n── token expired; renewed, resuming from #${lastSeq}`);
      continue;
    }

    /*
     * 4003 is the daemon dropping us for falling behind. It answered — loudly —
     * so the route is not implicated and the memo stays.
     *
     * `packages/web/src/stream.ts` has always treated it this way and this file
     * did not, which meant the two clients disagreed about the one condition where
     * the daemon is provably reachable. Coming straight back also earns a third
     * collapse, so this backs off before continuing; the cursor is at the head of
     * the log anyway, so there is nothing to catch up on in a hurry.
     */
    if (closedFor.startsWith("closed 4003")) {
      attempt = 0;
      warn(`\n── dropped for falling behind; resuming from #${lastSeq} in ${SLOW_CONSUMER_BACKOFF_MS}ms`);
      await sleep(SLOW_CONSUMER_BACKOFF_MS);
      continue;
    }

    /*
     * Anything else means the socket died for a reason the route is implicated
     * in, so drop the memo and let the next loop re-probe.
     *
     * This is the whole reason `resolveRoute` is called per connection rather
     * than once: a laptop that attached over the LAN and then moved to LTE has a
     * dead direct URL and a live relay tunnel, and without this it would retry
     * the dead one for ever. Direct is still probed first, so coming back onto
     * the LAN returns to the direct path on the next reconnect.
     *
     * Deliberately after the 4401 and 4003 branches above: both are the daemon
     * answering, and neither says anything at all about the route.
     */
    forgetRoute();

    attempt += 1;
    const backoff = Math.min(RECONNECT_MIN_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4));
    warn(`\n── ${closedFor}; reconnecting in ${jittered}ms from #${lastSeq}`);
    await sleep(jittered);
  }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

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
  // Mint before dispatching, so a bad key or a missing grant is one clear error
  // at the top rather than a confusing failure part-way through a command.
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
      const { agents } = await api<{ agents: AgentAvailability[] }>("/agents");
      for (const agent of agents) {
        out(describeAgent(agent));
        if (agent.hint) out(`    ${agent.hint.split("\n")[0]}`);
      }
      return;
    }

    /*
     * Agent credentials, from a terminal.
     *
     * The paste-a-token half of the settings screen, and deliberately only that
     * half. The wizard's four `/agent-auth/login*` routes are a polled transcript
     * with a one-time code typed back into it, which wants a screen holding the
     * run open rather than a command that exits — and a login code that is
     * printed and lost is not recoverable. Everything else under `/agent-auth`
     * is here, because a route only React can reach is a route nobody can bisect
     * when it starts answering 400.
     */
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
            // Per agent, and the daemon-wide line above cannot say this: an
            // agent whose own CLI does not resolve used to get a button and then
            // a 503.
            out(`    ${"login".padEnd(26)} not available here`);
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

      // Off argv when it is given and off the terminal when it is not. A token
      // passed as an argument is in the shell's history file and in `ps` for as
      // long as the request takes, and this is a long-lived credential for
      // somebody's model account — the one secret this client ever carries that
      // is not already an environment variable.
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
      // The daemon's own resolved path, not `parent/name`: the join happens
      // inside the tenant's root and is containment-checked there, so echoing the
      // argument back would print a path that may not be the one created.
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
      // Omitted entirely unless asked, so the daemon's own default applies.
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
        const result = await api<{ turn?: number; seq: number; cleared?: boolean }>(
          `/sessions/${id}/prompt`,
          { method: "POST", body: JSON.stringify({ text }) },
        );
        // A clear starts no turn — the daemon carries it out itself rather than
        // forwarding it — so there is a seq to point at and nothing to wait for.
        out(
          result.cleared === true
            ? `context cleared  seq ${result.seq}`
            : `accepted  turn ${result.turn}  seq ${result.seq}`,
        );
      } catch (error) {
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

    /*
     * Changing one of the agent's own controls.
     *
     * Both branches of `POST /sessions/:id/config`, because on the daemon they
     * are genuinely different code paths: `{configId,value}` validates against
     * the option's own choice list, `{modeId}` validates against ACP's legacy
     * `modes` field that claude fills in and kimi does not. The browser only ever
     * sends the first, so the second had no caller anywhere and no way to be
     * bisected when it starts answering 400.
     */
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

      // The daemon answers with its refreshed view rather than an echo, because
      // setting the model rebuilds the available modes and can reset the current
      // one — so what was asked for and what is now true differ often enough to
      // matter. Printing the whole set is what makes that visible.
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
        /*
         * A repeated answer is a `409` carrying a *success*-shaped body —
         * `{recorded, repeat: true, outcome, by}`, with no `error` key at all —
         * because the answer really did land. Without this branch `describeError`
         * found no message, fell back to the bare status, and this command
         * printed `!! 409` and exited 1 for an approval the agent was already
         * acting on. That is the commonest 409 there is: a retry after a timeout,
         * or a phone that answered the same request first.
         *
         * The attach loop above and `packages/web`'s `PermissionCard` have always
         * read it this way; this was the one caller that did not.
         *
         * Narrowed on `repeat`, not on the status: `permission_expired` is also a
         * 409 and *is* an error envelope, and it means the answer was thrown away
         * rather than recorded.
         */
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

    /*
     * Answer a question the agent asked.
     *
     * `<key>=<value>` pairs rather than JSON, because this is a terminal and the
     * shape is flat by construction — the daemon's projection has no nesting. A
     * repeated key builds a list, which is how a multi-select is answered.
     *
     * **Nothing here answers on your behalf.** `attach`'s auto-answer loop
     * deliberately does not learn about questions: `onPermission` can fall back
     * to allow-once because that is a defensible default, and a question has no
     * defensible default answer at all. The form is printed and that is where
     * this stops.
     */
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
        // The same 409-is-success rule the permission arm above spells out, and
        // narrowed on `repeat` for the same reason: `elicitation_expired` is also
        // a 409 and *is* an error envelope.
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
      // Loudly, because a silently short list reads exactly like a complete one.
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
      // Header to stderr, patch to stdout, so `client diff <id> <path> | git apply`
      // works — the same split the rest of this file already uses.
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
      // `?` for a `null`, the same way `entries` is printed two commands up:
      // `exists` and `registered` are both three-answer, and a filesystem that
      // did not answer within the probe's deadline is not the same claim as a
      // worktree git has forgotten. Printing the bare `null` said it was.
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
        // The scopes on their own line, because they are the thing worth reading
        // before anything else: this is what the plugin may reach on this machine.
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
        /*
         * Read whole and sent as one body rather than streamed off disk.
         *
         * A plugin is bounded at 2 MiB on the wire, so this is a couple of
         * megabytes at worst — and `fetch` with a `ReadableStream` body needs
         * `duplex: "half"` and HTTP/2 all the way through, which is exactly the
         * thing that fails differently against a relay than against a loopback
         * daemon. The upload route streams because it carries 100 MiB; this one
         * has no reason to.
         */
        const bytes = readFileSync(id);

        /*
         * ⚠ **What it asks for is read here, before anything is sent.**
         *
         * The scopes used to be printed from the *answer* — after the archive had
         * been unpacked on the machine, the row written and the plugin started —
         * with a comment arguing that was "the moment somebody is deciding". It
         * was not: by then there was nothing left to decide. `SECURITY.md` says
         * the blast radius is named *before* somebody consents to it, and this is
         * one of the two places that has to be true.
         *
         * Read locally rather than asked of the daemon, because the manifest is
         * inside the archive and the only reader that can run before the upload is
         * this one. `unpackArchive` and `parseManifest` rather than a second
         * reader: this is the same hardened path the daemon uses, spent on a
         * temporary directory on the operator's own machine, under their own hand,
         * and removed either way. The browser cannot do this — it may not import
         * from `src/` — which is why `packages/web/src/pluginArchive.ts` exists and
         * why the two are not shared.
         */
        const staging = await mkdtemp(join(tmpdir(), "reemoat-plugin-peek-"));
        let declared: PluginManifest | null = null;
        try {
          const unpacked = await unpackArchive({
            staging,
            // Built directly rather than through `Blob`, which is a DOM type this
            // package's lib does not carry.
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
          // Unreadable here is not a refusal: the daemon is the authority and may
          // well accept a shape this read did not survive. It only means nobody
          // can be told what the plugin asks for, which the prompt below says.
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
          // Hooks beside the scopes rather than under contributions: a plugin
          // declaring only hooks asks for no scopes and is still sent every
          // session's title, agent and workspace, and every permission an agent
          // raises. That belongs where somebody reading scopes will see it.
          if (declared.contributes.hooks.length > 0) out(`  told of: ${declared.contributes.hooks.join(", ")}`);
        }

        /*
         * Asked only when somebody is there to answer. A CLI that blocked on a
         * prompt would break every script that installs a plugin, so a
         * non-interactive stdin proceeds — the disclosure above still happened, and
         * `--yes` is how an interactive caller says the same thing on purpose.
         */
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
        await api(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
        out(`removed  ${id}  (and everything it kept)`);
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
          // Only when --force is actually the answer. `not_a_worktree` is a
          // directory we did not create and will never remove, and `session_live`
          // wants `stop` first — telling either of them to retry with --force
          // sends the user round a loop that cannot terminate.
          const code = (error.body as { error?: { code?: string } } | null)?.error?.code;
          if (code === "workspace_dirty") warn(`   pass --force to remove it anyway`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      return;
    }

    /*
     * Rename and pin, so `POST /sessions/:id/meta` is drivable without a browser.
     *
     * This file is the reference implementation the web client mirrors, and a
     * route only reachable from React is a route nobody can bisect when it starts
     * answering 400. An empty title clears it, which is what re-arms the daemon's
     * derivation from the next prompt.
     */
    case "title": {
      const id = positionals[1];
      if (!id) fail("title requires a session id");
      const text = positionals.slice(2).join(" ");
      const { session } = await api<{ session: SessionSnapshot }>(`/sessions/${id}/meta`, {
        method: "POST",
        body: JSON.stringify({ title: text.length === 0 ? null : text }),
      });
      // The daemon's own value, not the argument: a title is normalized on the way
      // in, so echoing what was typed would hide the clipping and the collapsing.
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

    /*
     * Stop the turn, not the session.
     *
     * A separate verb from `stop` rather than a flag on it, because the two have
     * opposite costs and a flag invites the wrong one: `stop` kills the agent and
     * ends the session, this leaves both exactly where they were. The two lines
     * printed keep that distinction visible — the second says whether the agent
     * had actually finished, which is an observation and not a promise.
     */
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
