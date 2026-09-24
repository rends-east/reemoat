import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, uptime as osUptime } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  ACP_AUTH_METHOD,
  AGENT_LOGIN,
  AgentUnavailableError,
  agentEnv,
  findOnPath,
  forgetPathHits,
  hasLoginFlow,
  isBuiltinAgentId,
  resolveAgent,
  type AgentId,
  type AgentLaunchConfig,
  type BuiltinAgentId,
  type LoginStatusProbe,
} from "../acp/agents.js";
import { BUILTIN_CATALOGUE, type MachineCatalogue, type SystemId } from "../acp/systems.js";
import { hostGit, type GitExec } from "../git.js";
import { probeBuild } from "../stall.js";
import type {
  AgentAvailability,
  AgentCliChoice,
  AgentHandle,
  AgentLoginSupport,
  AgentProcess,
  Liveness,
  LoginProcess,
  ReapDecision,
  SessionRuntime,
  StartRefusal,
} from "./types.js";
import { describeError } from "../http.js";

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;
type MaybePipedChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

class LocalChildProcess implements LoginProcess {
  constructor(protected readonly child: MaybePipedChild) {}

  get stdin(): Writable | null {
    return this.child.stdin;
  }

  get stdout(): Readable {
    return this.child.stdout;
  }

  get stderr(): Readable {
    return this.child.stderr;
  }

  get handle(): AgentHandle | null {
    const pid = this.child.pid;
    return pid == null ? null : { kind: "local", pid };
  }

  onceStartError(listener: (error: Error) => void): () => void {
    this.child.once("error", listener);
    return () => this.child.off("error", listener);
  }

  onceExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.child.once("exit", listener);
    return () => this.child.off("exit", listener);
  }

  get hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      this.child.once("exit", onExit);
    });
  }

  endStdin(): void {
    this.child.stdin?.end();
  }

  async kill(signal: NodeJS.Signals): Promise<void> {
    killGroup(this.child.pid ?? null, signal, () => this.child.kill(signal));
  }
}

class LocalAgentProcess extends LocalChildProcess implements AgentProcess {
  constructor(child: PipedChild) {
    super(child);
  }

  override get stdin(): Writable {
    return (this.child as PipedChild).stdin;
  }
}

const LOGIN_PROBE_TTL_MS = 3_000;

// Matches MODELS_TTL_MS so the model list and the build under it age together; a moved file is caught per use anyway (Q6.112).
const AGENT_CLI_TTL_MS = 10 * 60_000;

const LOGIN_PROBE_TIMEOUT_MS = 10_000;

/** The expiry is what keeps the record safe: a sign-in done outside this daemon clears nothing else. */
export const START_REFUSAL_TTL_MS = 10 * 60_000;

export const MAX_START_REFUSAL_CHARS = 512;

export function startRefusalLive(held: StartRefusal, now: number): boolean {
  return now - held.at < START_REFUSAL_TTL_MS;
}

export function firstVersion(text: string): string | null {
  // A lookbehind rather than a word boundary, which would read v2.1.259 as 1.259.
  return /(?<![\d.])(\d+(?:\.\d+)+)/.exec(text)?.[1] ?? null;
}

/** With an override name the adapter reads the CLI from that variable; without one the CLI replaces the command (Q4.114). */
export function spawnPlan(
  command: string,
  chosen: AgentCliChoice | null,
  overrideName: string | null,
): { command: string; env: NodeJS.ProcessEnv } {
  if (chosen === null) return { command, env: {} };
  if (overrideName === null) return { command: chosen.path, env: {} };
  return { command, env: { [overrideName]: chosen.path } };
}

export interface LoginSpawn {
  command: string;
  args: string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** BSD script takes argv after the file, util-linux one shell string; macOS script has no -e, so its exit status means nothing. */
export function hostLoginArgs(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
  scriptPath = "script",
): LoginSpawn {
  const bsd = platform === "darwin" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd";
  if (bsd) {
    return { command: scriptPath, args: ["-q", "/dev/null", command, ...args] };
  }
  return {
    command: scriptPath,
    args: ["-qec", [command, ...args].map(shellQuote).join(" "), "/dev/null"],
  };
}

/** Why this host cannot drive the agent's login, or null; BSD script refuses a piped stdin, so a flow that reads input is blocked there. */
export function loginBlockedReason(
  platform: NodeJS.Platform,
  interactiveStdin: boolean,
  hasScript: boolean,
  hasCli: boolean,
  hasFlow: boolean,
): "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null {
  // First: needing no sign-in is not a host limitation and must outrank the other three.
  if (!hasFlow) return "no_flow";
  if (!hasScript) return "no_script";
  if (!hasCli) return "no_cli";
  if (interactiveStdin && loginStdio(platform, interactiveStdin) === "pipe") {
    const bsd =
      platform === "darwin" ||
      platform === "freebsd" ||
      platform === "openbsd" ||
      platform === "netbsd";
    if (bsd) return "interactive_pty";
  }
  return null;
}

export function loginStdio(
  platform: NodeJS.Platform,
  interactiveStdin: boolean,
): "pipe" | "ignore" {
  if (interactiveStdin) return "pipe";
  const bsd =
    platform === "darwin" ||
    platform === "freebsd" ||
    platform === "openbsd" ||
    platform === "netbsd";
  return bsd ? "ignore" : "pipe";
}

export interface LocalRuntimeOptions {
  // Read at launch and never held, so a replaced token applies to the next session.
  secrets?: (agent: AgentId) => Record<string, string>;
  // Handed to providers/set over stdio, never merged into an environment.
  systemSecret?: (system: SystemId) => string | null;
  onWarning?: (detail: string) => void;
  // For the drivers only; nothing in production sets it.
  exec?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    stream: "stdout" | "stderr",
  ) => Promise<string | null>;
  // For the drivers only; null means could not tell.
  identify?: (path: string) => Promise<string | null>;
  machine?: MachineCatalogue;
}

export class LocalRuntime implements SessionRuntime {
  private readonly secrets: (agent: AgentId) => Record<string, string>;
  private readonly systemSecretOf: (system: SystemId) => string | null;
  private readonly onWarning: (detail: string) => void;
  private readonly exec: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    stream: "stdout" | "stderr",
  ) => Promise<string | null>;
  private readonly identify: (path: string) => Promise<string | null>;
  private readonly machine: MachineCatalogue;

  /** Memoised: `script` does not appear and disappear during a daemon's life. */
  private scriptResolved: string | null | undefined;
  private readonly cliChosen = new Map<AgentId, { at: number; value: AgentCliChoice; build: string | null }>();

  private readonly cliInFlight = new Map<AgentId, Promise<AgentCliChoice | null>>();

  // probeGeneration stops an in-flight probe writing a pre-clear answer back after forgetAvailability.
  private readonly loginProbed = new Map<AgentId, { at: number; value: boolean | null }>();
  private readonly loginInFlight = new Map<AgentId, Promise<boolean | null>>();
  private probeGeneration = 0;

  // Deliberately in memory and not cleared by forgetAvailability: a durable record outlives its truth (Q7.99).
  private readonly startRefused = new Map<AgentId, StartRefusal>();

  constructor(options: LocalRuntimeOptions = {}) {
    this.secrets = options.secrets ?? (() => ({}));
    this.systemSecretOf = options.systemSecret ?? (() => null);
    this.onWarning = options.onWarning ?? (() => {});
    this.exec = options.exec ?? ((command, args, env, stream) => runProbe(command, args, env, stream));
    this.identify = options.identify ?? cliBuild;
    this.machine = options.machine ?? BUILTIN_CATALOGUE;
  }

  private builtinLogin(agent: AgentId): (typeof AGENT_LOGIN)[BuiltinAgentId] | null {
    return isBuiltinAgentId(agent) ? AGENT_LOGIN[agent] : null;
  }

  credentialSlots(agent: AgentId): readonly string[] {
    const builtin = this.builtinLogin(agent);
    if (builtin !== null) return builtin.envNames;
    return this.machine.harness(agent)?.envNames ?? [];
  }

  get catalogue(): MachineCatalogue {
    return this.machine;
  }

  readonly clientFileIo = true;

  get loginSupported(): boolean {
    return this.scriptPath() !== null;
  }

  describe(agent: AgentId): AgentLaunchConfig {
    return resolveAgent(agent, this.machine);
  }

  async availability(): Promise<AgentAvailability[]> {
    const generation = this.probeGeneration;
    return Promise.all(
      this.machine.harnessIds().map(async (id): Promise<AgentAvailability> => {
        const contributed = this.machine.harness(id);
        const extra =
          contributed === null
            ? {}
            : {
                label: contributed.name,
                contributedBy: { pluginId: contributed.pluginId, pluginName: contributed.pluginName },
              };
        let config: AgentLaunchConfig;
        try {
          config = resolveAgent(id, this.machine);
        } catch (error) {
          return {
            id,
            displayName: contributed?.name ?? id,
            available: false,
            hint: describeError(error),
            installable: error instanceof AgentUnavailableError && error.installable,
            loggedIn: null,
            lastStartRefusal: this.startRefusal(id),
            ...extra,
          };
        }
        const loggedIn = await this.loginState(id, generation);
        return {
          id,
          displayName: config.displayName,
          available: true,
          installable: false,
          ...extra,
          hint: loggedIn === false ? config.authHint : this.cannotAskHint(id, loggedIn),
          loggedIn,
          lastStartRefusal: this.startRefusal(id),
        };
      }),
    );
  }

  noteStartRefusal(agent: AgentId, message: string, routed: boolean): void {
    this.startRefused.set(agent, {
      at: Date.now(),
      routed,
      message: message.slice(0, MAX_START_REFUSAL_CHARS),
    });
  }

  forgetStartRefusal(agent?: AgentId): void {
    if (agent === undefined) this.startRefused.clear();
    else this.startRefused.delete(agent);
  }

  private startRefusal(agent: AgentId): StartRefusal | null {
    const held = this.startRefused.get(agent);
    if (held === undefined) return null;
    if (startRefusalLive(held, Date.now())) return held;
    this.startRefused.delete(agent);
    return null;
  }

  forgetAvailability(): void {
    this.probeGeneration += 1;
    this.loginProbed.clear();
    this.loginInFlight.clear();
    this.cliChosen.clear();
    // Safe to clear: each in-flight decision's cleanup deletes only the entry it still owns.
    this.cliInFlight.clear();
    forgetPathHits();
  }

  /** The command comes from AGENT_LOGIN, never a request; detached so the kill ladder reaches the whole group. */
  async login(agent: AgentId): Promise<LoginProcess | null> {
    const login = this.builtinLogin(agent);
    const flow = login?.args ?? null;
    if (login === null || flow === null) return null;
    const script = this.scriptPath();
    if (script === null) return null;
    // The chosen build, so the login writes credentials for the binary sessions run.
    const chosen = await this.agentCli(agent);
    const command = chosen?.path ?? null;
    if (command === null) {
      this.onWarning(`cannot log ${agent} in: ${login.command} is not on PATH`);
      return null;
    }
    const spec = hostLoginArgs(process.platform, command, flow, script);
    const stdin = loginStdio(process.platform, login.interactiveStdin);
    const child = spawn(spec.command, spec.args, {
      env: { ...agentEnv(), ...this.secrets(agent) },
      stdio: [stdin, "pipe", "pipe"],
      detached: true,
    }) as MaybePipedChild;
    // An EPIPE on a stdin nobody reads would otherwise be an unhandled error.
    child.stdin?.on("error", () => {});
    return new LocalChildProcess(child);
  }

  loginSupport(agent: AgentId): AgentLoginSupport {
    const login = this.builtinLogin(agent);
    // A contributed harness must answer no_flow rather than be absent, or agentStance badges it as unchecked.
    if (login === null) {
      return { supported: false, blocked: "no_flow", needsInput: false, canSignOut: false };
    }
    const blocked = loginBlockedReason(
      process.platform,
      login.interactiveStdin,
      this.scriptPath() !== null,
      this.resolveLoginBinary(agent) !== null,
      isBuiltinAgentId(agent) && hasLoginFlow(agent),
    );
    return {
      supported: blocked === null,
      blocked,
      needsInput: login.interactiveStdin,
      canSignOut: login.logoutArgs !== null,
    };
  }

  /** Runs without the pasted secrets, unlike login: the route clears them first. */
  async logout(agent: AgentId): Promise<{ ok: boolean; detail: string | null } | null> {
    const login = this.builtinLogin(agent);
    const args = login?.logoutArgs ?? null;
    if (login === null || args === null) return null;
    const command = (await this.agentCli(agent))?.path ?? null;
    if (command === null) {
      return { ok: false, detail: `${login.command} is not on this daemon's PATH` };
    }
    const out = await this.exec(command, args, agentEnv(), "stdout");
    const err = await this.exec(command, args, agentEnv(), "stderr");
    const detail = [out, err].map((part) => (part ?? "").trim()).filter((part) => part.length > 0)[0] ?? null;
    // Not read off an exit code; the route's re-probe settles it.
    return { ok: true, detail };
  }

  systemSecret(system: SystemId): string | null {
    return this.systemSecretOf(system);
  }

  async launch(agent: AgentId, extra: NodeJS.ProcessEnv = {}, routed = false): Promise<AgentProcess> {
    const config = resolveAgent(agent, this.machine);
    const chosen = await this.agentCli(agent);
    const { command, env: cliEnv } = spawnPlan(config.command, chosen, this.builtinLogin(agent)?.executableEnv ?? null);
    // Detached so the whole group can be killed: adapters' own children are not cleaned up under SIGKILL.
    const child = spawn(command, config.args, {
      // Secrets after the ambient env so a pasted token wins; extra last so a pinned model beats the host's.
      // A routed session gets no harness credentials: it is aimed at another vendor's endpoint.
      env: { ...config.env, ...cliEnv, ...(routed ? {} : this.secrets(agent)), ...extra },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as PipedChild;
    // An EPIPE on stdin is otherwise fatal to the whole daemon.
    child.stdin.on("error", () => {});
    return new LocalAgentProcess(child);
  }

  /** A method id only when not routed and a key was pasted, since launch withholds secrets on a routed session. */
  authMethod(agent: AgentId, routed = false): string | null {
    if (routed) return null;
    const method = ACP_AUTH_METHOD[agent];
    if (method === undefined) return null;
    return Object.keys(this.secrets(agent)).length > 0 ? method : null;
  }

  git(): GitExec {
    return hostGit;
  }

  private resolveLoginBinary(agent: AgentId): string | null {
    const login = this.builtinLogin(agent);
    if (login === null) return null;
    const overrideName = login.executableEnv;
    if (overrideName !== null) {
      const override = (process.env[overrideName] ?? "").trim();
      if (override.length > 0) return override;
    }
    return findOnPath(login.command);
  }

  /** Override variable first, then the first copy on PATH; held for AGENT_CLI_TTL_MS and re-checked against the file on every use (Q6.112). */
  async agentCli(agent: AgentId): Promise<AgentCliChoice | null> {
    const held = this.cliChosen.get(agent);
    if (held !== undefined && Date.now() - held.at < AGENT_CLI_TTL_MS) {
      // Fenced on probeGeneration across the await; a null identity keeps the held choice.
      const generation = this.probeGeneration;
      const now = await this.identify(held.value.path);
      if (generation === this.probeGeneration && (now === null || now === held.build)) return held.value;
      if (this.cliChosen.get(agent) === held) this.cliChosen.delete(agent);
      const current = this.cliChosen.get(agent);
      if (current !== undefined) return current.value;
    }
    const running = this.cliInFlight.get(agent);
    if (running !== undefined) return running;

    const generation = this.probeGeneration;
    const run = this.chooseCli(agent)
      .then((chosen) => {
        // A miss is never held, so a fresh install is seen at the next launch.
        if (chosen !== null && generation === this.probeGeneration) {
          this.cliChosen.set(agent, { at: Date.now(), value: chosen.value, build: chosen.build });
        }
        return chosen?.value ?? null;
      })
      .finally(() => {
        if (this.cliInFlight.get(agent) === run) this.cliInFlight.delete(agent);
      });
    this.cliInFlight.set(agent, run);
    return run;
  }

  /** The file is identified before --version so a swap in between re-chooses rather than misreports. */
  private async chooseCli(agent: AgentId): Promise<{ value: AgentCliChoice; build: string | null } | null> {
    const login = this.builtinLogin(agent);
    if (login === null) return null;

    const overrideName = login.executableEnv;
    if (overrideName !== null) {
      const override = (process.env[overrideName] ?? "").trim();
      if (override.length > 0) {
        const build = await this.identify(override);
        return { value: { path: override, version: await this.cliVersion(override), source: "override" }, build };
      }
    }

    const onPath = findOnPath(login.command);
    if (onPath === null) return null;
    const build = await this.identify(onPath);
    return { value: { path: onPath, version: await this.cliVersion(onPath), source: "path" }, build };
  }

  private async cliVersion(command: string): Promise<string | null> {
    const out = await this.exec(command, ["--version"], agentEnv(), "stdout");
    return firstVersion(out ?? "");
  }

  private scriptPath(): string | null {
    if (this.scriptResolved === undefined) this.scriptResolved = findOnPath("script");
    return this.scriptResolved;
  }

  private cannotAskHint(agent: AgentId, loggedIn: boolean | null): string | null {
    if (loggedIn !== null) return null;
    const login = this.builtinLogin(agent);
    if (login === null) return null;
    if (login.status === null) return null;
    if (this.resolveLoginBinary(agent) !== null) return null;
    const overrideName = login.executableEnv;
    const remedy =
      overrideName === null
        ? `Put it on this daemon's PATH`
        : `Set ${overrideName} to the binary you log in with, or put it on this daemon's PATH`;
    return (
      `${login.command} could not be found, so this daemon cannot tell whether ` +
      `${agent} is signed in. ${remedy} (a service does not read your shell profile), ` +
      `or run deploy/agents.sh, which installs it.`
    );
  }

  private async loginState(agent: AgentId, generation: number): Promise<boolean | null> {
    const cached = this.loginProbed.get(agent);
    if (cached !== undefined && Date.now() - cached.at < LOGIN_PROBE_TTL_MS) return cached.value;

    const running = this.loginInFlight.get(agent);
    if (running !== undefined) return running;

    const probe = this.readLoginState(agent)
      .then((value) => {
        if (generation === this.probeGeneration) {
          this.loginProbed.set(agent, { at: Date.now(), value });
        }
        return value;
      })
      .finally(() => {
        this.loginInFlight.delete(agent);
      });
    this.loginInFlight.set(agent, probe);
    return probe;
  }

  /**
   * True, false, or null for cannot tell; a pasted credential only answers cannot tell, never overrides a clean false.
   * `signedOut(agent)` used to live here as a prompt-path guard; the agent's own auth failure now ends the session instead.
   */
  private async readLoginState(agent: AgentId): Promise<boolean | null> {
    const pasted = Object.keys(this.secrets(agent)).length > 0;
    // Never false for a contributed harness: admit refuses on false, which is why a start refusal is kept separately.
    const spec = this.builtinLogin(agent);
    if (spec === null) return pasted ? true : null;

    if (spec.status !== null) {
      const command = (await this.agentCli(agent))?.path ?? null;
      if (command === null) return pasted ? true : null;
      const answer = await this.probe(command, spec.status.args, agent, spec.status.stream);
      const said = answer === null ? null : readLoginAnswer(spec.status, answer);
      if (said !== null) return said;
      return pasted ? true : null;
    }

    if (spec.credentialPath !== null) {
      if (existsSync(join(homedir(), spec.credentialPath))) return true;
      return pasted ? true : null;
    }
    return pasted ? true : null;
  }

  /** Runs with the pasted credential in its environment, which readLoginState relies on. */
  private probe(
    command: string,
    args: readonly string[],
    agent: AgentId,
    stream: "stdout" | "stderr",
  ): Promise<string | null> {
    return this.exec(command, args, { ...agentEnv(), ...this.secrets(agent) }, stream);
  }

  async kill(handle: AgentHandle | null, signal: NodeJS.Signals): Promise<void> {
    if (handle?.kind !== "local") return;
    killGroup(handle.pid, signal, () => process.kill(handle.pid, signal));
  }

  async alive(handle: AgentHandle | null): Promise<Liveness> {
    if (handle?.kind !== "local") return "dead";
    return isAlive(handle.pid);
  }

  /** Fenced on boot time only, so pids that wrap within a boot are not caught; not awaited, so a kill is reported unconfirmed. */
  reap(handle: AgentHandle | null, createdAt: number, enabled: boolean): ReapDecision {
    if (handle === null) {
      return { killed: false, confirmedDead: true, detail: "the daemon restarted; no agent was recorded" };
    }
    if (handle.kind !== "local") {
      return {
        killed: false,
        confirmedDead: false,
        detail: "the daemon restarted; the recorded agent was not a local process and was left alone",
      };
    }
    const { pid } = handle;
    // Only a definite death confirms: unknown is EPERM, a pid that belongs to somebody else now.
    if (isAlive(pid) === "dead") {
      return { killed: false, confirmedDead: true, detail: "the daemon restarted; its agent was already gone" };
    }
    const bootedAt = Date.now() - osUptime() * 1000;
    if (createdAt < bootedAt) {
      return {
        killed: false,
        confirmedDead: false,
        detail: `the daemon restarted; pid ${pid} predates this boot and was left alone (pids are recycled)`,
      };
    }
    if (!enabled) {
      return { killed: false, confirmedDead: false, detail: `the daemon restarted; pid ${pid} left alone` };
    }
    killGroup(pid, "SIGKILL", () => process.kill(pid, "SIGKILL"));
    return { killed: true, confirmedDead: false, detail: `the daemon restarted; killed orphaned agent ${pid}` };
  }
}

function killGroup(pid: number | null, signal: NodeJS.Signals, fallback: () => void): void {
  if (pid == null) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      fallback();
    } catch {
      // Already gone, or never started.
    }
  }
}

function runProbe(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stream: "stdout" | "stderr",
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: LOGIN_PROBE_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        // Exit 1 is an answer for the status commands; the error only matters when there is no output at all.
        const text = (stream === "stderr" ? stderr : stdout).toString().trim();
        if (text.length > 0) return resolve(text);
        resolve(error === null ? "" : null);
      },
    );
  });
}

/** Missing is a key of its own so a vanished CLI is a change; null is could not tell and never re-chooses. */
async function cliBuild(path: string): Promise<string | null> {
  const probe = await probeBuild(path);
  if (probe === null) return null;
  return probe.kind === "file" ? probe.key : "\0missing";
}

/** Unreadable output is cannot tell, never logged out; exit codes are not read, and signedOut is tested first. */
export function readLoginAnswer(probe: LoginStatusProbe, answer: string): boolean | null {
  if (probe.reads === "json") {
    try {
      const parsed = JSON.parse(answer) as { loggedIn?: unknown };
      if (parsed.loggedIn === true) return true;
      if (parsed.loggedIn === false) return false;
    } catch {
      // Not JSON: cannot tell, not logged out.
    }
    return null;
  }
  if (probe.signedOut.test(answer)) return false;
  if (probe.signedIn.test(answer)) return true;
  return null;
}

export function isAlive(pid: number): Liveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
