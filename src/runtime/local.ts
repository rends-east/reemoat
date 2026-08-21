import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir, uptime as osUptime } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  AGENT_IDS,
  AGENT_LOGIN,
  agentEnv,
  findOnPath,
  resolveAgent,
  type AgentId,
  type AgentLaunchConfig,
  type LoginStatusProbe,
} from "../acp/agents.js";
import { hostGit, type GitExec } from "../git.js";
import type {
  AgentAvailability,
  AgentHandle,
  AgentLoginSupport,
  AgentProcess,
  Liveness,
  LoginProcess,
  ReapDecision,
  SessionRuntime,
} from "./types.js";
import { describeError } from "../http.js";

/**
 * The agent as a child process of this daemon.
 *
 * The only runtime, and for most of its length the same code it was when it was
 * one of two — that continuity is deliberate, because this is the path
 * `scripts/harness.ts` and every offline driver already took, so what the drivers
 * check and what the daemon does have never diverged here.
 *
 * Two things are genuinely new and both came back from the container runtime
 * rather than being invented: driving an agent's own login under a pty, and
 * probing whether an agent is actually signed in. Both were written for a person
 * with no shell on the machine — which was a tenant then and is somebody holding
 * a phone now.
 */

type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;
/** A login's child, whose stdin is `/dev/null` for a flow that reads none. */
type MaybePipedChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

/**
 * The shared body of both spawns, with the nullable stdin a login may have.
 *
 * Split from {@link LocalAgentProcess} rather than widening it, because the two
 * genuinely differ in one field and in nothing else: every session has stdin
 * (it is where JSON-RPC goes), and a device-code login on BSD deliberately has
 * none. The subclass narrows the getter back so no session-side caller acquires
 * a null check about a case that cannot happen.
 */
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
    // Optional because a flow spawned with `stdio: ["ignore", …]` has nothing to
    // close. It is still the first rung of the kill ladder for the other two, so
    // this is a skip rather than a branch anybody has to take.
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

  /** Narrowed: a session always has stdin. See {@link LocalChildProcess}. */
  override get stdin(): Writable {
    return (this.child as PipedChild).stdin;
  }
}

/**
 * How long a "is this agent signed in" answer is reused.
 *
 * Short because it is the one fact here that changes while the daemon runs —
 * somebody logs in and expects the screen to say so. Non-zero because two screens
 * ask on mount and each answer costs spawning a CLI.
 */
const LOGIN_PROBE_TTL_MS = 3_000;

/** How long a status command may take before it is treated as no answer. */
const LOGIN_PROBE_TIMEOUT_MS = 10_000;

/** What a pty-allocating login spawn looks like. */
export interface LoginSpawn {
  command: string;
  args: string[];
}

/**
 * Quoting for the one place a command becomes a shell string.
 *
 * Only util-linux's `script -c` needs this, and it needs it for a reason the
 * container version could not have had: in the image `command` was the literal
 * word `claude`, and here it is whatever `findOnPath` resolved — an absolute
 * path, and absolute paths contain spaces (`/Users/x/Library/Application
 * Support/…/claude` is not exotic). Joined naively that becomes two words and the
 * login fails with something about `Support/…` not being found.
 *
 * Single quotes with the standard `'\''` escape, so there is no character a path
 * could contain that reopens the string. This is defence against *our own* PATH
 * resolution, not against a caller — the command still comes from a fixed table
 * and nothing on the wire names a program.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * How an interactive agent login is started, under a pty, on this platform.
 *
 * Every agent's login flow is an interactive terminal program and will not prompt
 * without a pty; a daemon's stdin is never a tty, so something has to allocate
 * one on the far side. `script` does, and it is the same answer the container
 * runtime reached — there it was `docker exec -it` that could not be used, here
 * it is the spawn itself, and the cause is identical.
 *
 * **Two programs, one name.** util-linux's `script` takes the command as a single
 * string run through `/bin/sh -c`; BSD's takes it as argv after the typescript
 * file. Getting this wrong does not fail loudly — the BSD form on Linux writes a
 * file called `claude` and records nothing.
 *
 * Everything not known to be BSD takes the util-linux form, because Linux is
 * where this is deployed and an unknown platform is more likely to be Linux-like.
 *
 * One consequence worth writing down rather than discovering: **macOS `script`
 * has no `-e`**, so it does not propagate the child's exit status and a failed
 * `claude auth login` exits `script` with 0. Nothing here reads that code — the
 * wizard re-probes availability when the run ends rather than trusting it — but
 * "exit 0 means it worked" is a one-line change somebody will make.
 *
 * Pure, so it can be asserted on both platforms from a machine that is only one
 * of them.
 */
export function hostLoginArgs(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
  scriptPath = "script",
): LoginSpawn {
  const bsd = platform === "darwin" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd";
  if (bsd) {
    // argv boundaries preserved, no shell involved at all.
    return { command: scriptPath, args: ["-q", "/dev/null", command, ...args] };
  }
  return {
    command: scriptPath,
    args: ["-qec", [command, ...args].map(shellQuote).join(" "), "/dev/null"],
  };
}

/**
 * Whether a login's pty gets a stdin pipe, and it is a platform fix rather than
 * a preference.
 *
 * **The login wizard does not run on macOS at all, for any agent, and it is the
 * pipe that stops it.** Found 2026-08-07 and reproduced outside the daemon: BSD
 * `script` reads its *own* stdin's termios in order to copy the settings onto
 * the pty it is about to allocate, and `LocalRuntime.login` spawns it with a
 * pipe — so it exits 1 with `script: tcgetattr/ioctl: Operation not supported on
 * socket` before the agent is reached. The same spawn with stdin on `/dev/null`
 * succeeds. Invisible until now because Linux is where this deploys and
 * util-linux's `-qec` form does not ask.
 *
 * So the fix is available exactly where the flow does not need the pipe, and
 * `AGENT_LOGIN[agent].interactiveStdin` is what says so. Two of the three are
 * device-code flows that never read a byte back; claude's waits on a paste
 * prompt and therefore **stays broken on macOS**, which is not fixed here and is
 * reported as a sentence by the client instead of as a `tcgetattr` line. Taking
 * the pipe away from claude too would fix two agents by breaking the third,
 * which is a decision about all three rather than about the platform.
 *
 * **Linux keeps its pipe unconditionally**, and that is the conservative half:
 * `script` there works today with one, an immediate stdin EOF is a plausible way
 * for it to decide the session is over, and Linux is where this deploys. There
 * is nothing to buy by changing it.
 *
 * Pure, so `daemoncheck` asserts both platforms from a machine that is only one
 * of them — the same reason `hostLoginArgs` is.
 */
/**
 * Why this host cannot drive an agent's own login, when it cannot.
 *
 * **Three ways to fail and the third had no answer.** `script` missing and the
 * CLI not resolving were already folded into `supported`; this adds the one that
 * is a fact about the *platform and the flow together*, and it is the one that
 * had been costing somebody a wizard that opens and then dies in a `<pre>`.
 *
 * BSD `script` reads the termios of **its own stdin** in order to copy it onto
 * the pty it allocates. {@link loginStdio} is the fix, and it works by handing it
 * `/dev/null` — which is only available where the flow reads no input at all. A
 * flow that needs stdin must be given a pipe, a pipe has no termios, and `script`
 * exits with `tcgetattr/ioctl: Operation not supported on socket` before the CLI
 * is ever executed. On this platform, for that flow, there is nothing to try.
 *
 * Today that is exactly `claude` on macOS: it prints a URL and waits for the code
 * to be pasted back, so `interactiveStdin` is true and cannot be traded away
 * without taking away the box the code goes in.
 *
 * **This used to be reachable only by tapping the button.** `ui/login.ts` still
 * recognises the failure and says the right thing, and that stays — a transcript
 * can carry it for reasons this cannot predict. But a control that cannot work
 * should not be offered, and the remedy (`claude setup-token`, pasted as a
 * credential) is a different control on the same screen.
 *
 * Pure, so `daemoncheck` asserts every platform from a machine that is one of
 * them — the same reason {@link loginStdio} and `hostLoginArgs` are.
 */
export function loginBlockedReason(
  platform: NodeJS.Platform,
  interactiveStdin: boolean,
  hasScript: boolean,
  hasCli: boolean,
): "no_script" | "no_cli" | "interactive_pty" | null {
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
  /**
   * This user's pasted credentials for an agent, as environment variables.
   *
   * A function rather than a map so the runtime never holds the secrets, and
   * injected rather than read here so it never learns about SQLite. Read at
   * launch rather than captured, so replacing a token takes effect on the next
   * session without a daemon restart.
   */
  secrets?: (agent: AgentId) => Record<string, string>;
  onWarning?: (detail: string) => void;
  /**
   * How a non-interactive probe is run, for the drivers only.
   *
   * The same shape of seam as `secrets` and `onWarning`, and it earns its place
   * for the reason `probeTimeoutMs` does in `browse.ts`: what it stands in for is
   * a binary that is not installed on the machine running the driver, so the
   * branches around it — the JSON that disagrees with the exit code, output that
   * is not JSON at all, a pasted credential overriding a clean `false` — were
   * unreachable from any test. Nothing in `scripts/daemon.ts` sets it.
   */
  exec?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    stream: "stdout" | "stderr",
  ) => Promise<string | null>;
}

export class LocalRuntime implements SessionRuntime {
  private readonly secrets: (agent: AgentId) => Record<string, string>;
  private readonly onWarning: (detail: string) => void;
  private readonly exec: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    stream: "stdout" | "stderr",
  ) => Promise<string | null>;

  /** Memoised: `script` does not appear and disappear during a daemon's life. */
  private scriptResolved: string | null | undefined;
  /**
   * Memoised for the same reason: a vendored binary does not move at runtime.
   *
   * Per agent, because two of the three vendor a CLI and they vendor it
   * differently — see {@link vendoredCli}.
   */
  private readonly vendored = new Map<AgentId, string | null>();

  /**
   * The login probe's cache, and the two things that keep it honest.
   *
   * `loginInFlight` collapses concurrent askers onto one probe: `GET /agents` and
   * `GET /agent-auth` both route through here and the Settings screen refetches
   * on every change, so N callers arriving together would otherwise be N spawns
   * of a CLI.
   *
   * `probeGeneration` is what stops an in-flight probe writing its *pre-clear*
   * answer back after `forgetAvailability()` — the exact race that makes somebody
   * who has just signed in keep being told they have not.
   */
  private readonly loginProbed = new Map<AgentId, { at: number; value: boolean | null }>();
  private readonly loginInFlight = new Map<AgentId, Promise<boolean | null>>();
  private probeGeneration = 0;

  constructor(options: LocalRuntimeOptions = {}) {
    this.secrets = options.secrets ?? (() => ({}));
    this.onWarning = options.onWarning ?? (() => {});
    this.exec = options.exec ?? ((command, args, env, stream) => runProbe(command, args, env, stream));
  }

  /**
   * Kept, because here it costs nothing and buys something.
   *
   * The agent is a child of this daemon running as the same user on the same
   * filesystem, so a write the daemon performs for it reaches nowhere the agent
   * could not reach itself — there is no boundary to breach. And Kimi routes its
   * writes through the client when offered, which is where the `source:
   * "fs_write"` half of the `file_change` pair comes from.
   */
  readonly clientFileIo = true;

  /**
   * Whether a login can be driven at all, which is a question about `script`.
   *
   * Reported rather than assumed so the Settings screen draws the wizard only
   * when tapping it will do something. A host without `script` still has the
   * paste-a-token path, which always works.
   */
  get loginSupported(): boolean {
    return this.scriptPath() !== null;
  }

  describe(agent: AgentId): AgentLaunchConfig {
    return resolveAgent(agent);
  }

  /**
   * What `GET /agents` reports, and the login state is a real probe now.
   *
   * `available` only ever meant "the adapter is on PATH", so an installed but
   * logged-out agent reported `true` and the person found out at
   * `502 agent_auth_required`, after a worktree had already been created. The
   * probe is what makes the Settings screen able to say which of the two states
   * an agent is in before anybody starts a session.
   */
  async availability(): Promise<AgentAvailability[]> {
    const generation = this.probeGeneration;
    return Promise.all(
      AGENT_IDS.map(async (id): Promise<AgentAvailability> => {
        let config: AgentLaunchConfig;
        try {
          config = resolveAgent(id);
        } catch (error) {
          return {
            id,
            displayName: id,
            available: false,
            hint: describeError(error),
            loggedIn: null,
          };
        }
        const loggedIn = await this.loginState(id, generation);
        return {
          id,
          displayName: config.displayName,
          available: true,
          // The hint is what to *do*, and "cannot tell" needs one too.
          //
          // It used to be attached only to `loggedIn === false`, on the reasoning
          // that the other two states have nothing to act on. That was wrong for
          // one of them and the cost was measured: with `claude` off this daemon's
          // PATH the probe could not run, every agent reported "cannot tell", and
          // the screen said so with no way to find out why. When the reason is
          // "there is no binary to ask", saying that is the whole remedy.
          hint: loggedIn === false ? config.authHint : this.cannotAskHint(id, loggedIn),
          loggedIn,
        };
      }),
    );
  }

/*
 * `signedOut(agent)` used to live here, and it is gone rather than kept.
 *
 * It answered "is this agent known signed out" for a guard on the prompt path,
 * and that guard was the wrong shape: it spawned the agent's CLI on the hot path,
 * was only ever as fresh as its 3s cache, and — the reason it was removed —
 * made every offline driver depend on whether the person running it was signed
 * in. A stub runtime inherits this class, and `resolveLoginBinary` finds the
 * adapter's own vendored binary in `node_modules`, so CI (signed in to nothing)
 * refused a prompt two assertions expected to land.
 *
 * What replaced it is not a better probe but a different source: the agent says
 * so itself. `isAuthFailure` reads `errorKind` off the ACP error on the event
 * pump, at the only moment that cannot be stale, and the session ends carrying
 * `agent_signed_out`. Deleted with its caller rather than left for a future one,
 * for the reason `paths.ts` gives about `atOrUnderReal`: a method with no callers
 * and a docblock arguing for itself reads as live policy to whoever finds it.
 */

  /** See {@link SessionRuntime.forgetAvailability}. */
  forgetAvailability(): void {
    this.probeGeneration += 1;
    this.loginProbed.clear();
    this.loginInFlight.clear();
  }

  /**
   * Starts the agent's own login, under a pty, as this user.
   *
   * The command comes from {@link AGENT_LOGIN} and is never a request field, so
   * "a caller cannot run code of their choosing as the daemon" holds because
   * there is nothing to pass. That mattered as a tenant fence and it still
   * matters: this daemon is reachable from the internet through the relay.
   *
   * `detached`, and that is not optional — it is the direct analogue of the
   * container image's `setsid -w`. `script` forks the CLI and the CLI may fork
   * again, so the kill ladder in `LoginRun.dispose()` has to reach the *group*.
   * Without it, killing `script` strands the CLI holding a pty for every login
   * somebody walked away from.
   */
  async login(agent: AgentId): Promise<LoginProcess | null> {
    const script = this.scriptPath();
    if (script === null) return null;
    const command = this.resolveLoginBinary(agent);
    if (command === null) {
      this.onWarning(`cannot log ${agent} in: ${AGENT_LOGIN[agent].command} is not on PATH`);
      return null;
    }
    const spec = hostLoginArgs(process.platform, command, AGENT_LOGIN[agent].args, script);
    const stdin = loginStdio(process.platform, AGENT_LOGIN[agent].interactiveStdin);
    const child = spawn(spec.command, spec.args, {
      // The same environment `launch` gives an agent, and for the same reason:
      // `agentEnv` drops this daemon's own `REEMOAT_*` names (and the parent's
      // `CLAUDE_*` session, while preserving `CLAUDE_CODE_EXECUTABLE`, which a
      // login must honour or it writes credentials for a build the session never
      // reads). This used to be `{...process.env}`, which put `REEMOAT_TOKEN` in
      // front of a process whose entire output is captured and shown in Settings.
      // Hygiene rather than a fence, exactly as it is one function down.
      env: { ...agentEnv(), ...this.secrets(agent) },
      // `stdin` is `"ignore"` only where the flow reads none *and* the platform
      // needs it to be — see `loginStdio`, which is the fix for BSD `script`
      // refusing to allocate a pty when its own stdin is a pipe.
      stdio: [stdin, "pipe", "pipe"],
      detached: true,
    }) as MaybePipedChild;
    // An EPIPE on a stdin nobody is reading would be an unhandled 'error'. Absent
    // where there is no pipe at all, which is the case this `?.` is for.
    child.stdin?.on("error", () => {});
    return new LocalChildProcess(child);
  }

  /**
   * Whether this agent's login can be driven here, per agent.
   *
   * Three facts and all three have to hold, which is why the daemon-wide
   * `loginSupported` was not enough on its own: `script` allocates the pty, the
   * agent's *CLI* has to resolve (a different binary from the adapter, and
   * claude's ships inside an SDK package with no `bin` entry), and the flow's
   * own shape decides whether there is anything to type. Answered before the
   * button is drawn rather than as a `503` after it is tapped.
   */
  loginSupport(agent: AgentId): AgentLoginSupport {
    const blocked = loginBlockedReason(
      process.platform,
      AGENT_LOGIN[agent].interactiveStdin,
      this.scriptPath() !== null,
      this.resolveLoginBinary(agent) !== null,
    );
    return {
      supported: blocked === null,
      blocked,
      needsInput: AGENT_LOGIN[agent].interactiveStdin,
      canSignOut: AGENT_LOGIN[agent].logoutArgs !== null,
    };
  }

  /**
   * Runs the agent's own sign-out.
   *
   * **No pty, unlike the login**, and that is a property of the command rather
   * than a shortcut: signing out prints a line and exits, so it goes through the
   * same `exec` seam the status probe uses — which is also what lets the drivers
   * substitute it.
   *
   * The environment is `agentEnv()` **without** `this.secrets(agent)`, which is
   * the one place these two spawns deliberately differ. A pasted token is a
   * credential of ours, the route clears it before calling this, and handing it
   * to a logout would be asking the CLI to forget one credential while we hold
   * another out in front of it.
   */
  async logout(agent: AgentId): Promise<{ ok: boolean; detail: string | null } | null> {
    const args = AGENT_LOGIN[agent].logoutArgs;
    if (args === null) return null;
    const command = this.resolveLoginBinary(agent);
    if (command === null) {
      return { ok: false, detail: `${AGENT_LOGIN[agent].command} is not on this daemon's PATH` };
    }
    // Both streams, because these two CLIs do not agree on which they answer on
    // — the same measurement `LoginStatusProbe.stream` exists for.
    const out = await this.exec(command, args, agentEnv(), "stdout");
    const err = await this.exec(command, args, agentEnv(), "stderr");
    const detail = [out, err].map((part) => (part ?? "").trim()).filter((part) => part.length > 0)[0] ?? null;
    // `ok` is not read off an exit code, for the reason the probe's docblock
    // gives: a non-zero exit cannot be told from a crash or a missing binary.
    // What settles it is the re-probe the route triggers by forgetting the cache.
    return { ok: true, detail };
  }

  async launch(agent: AgentId): Promise<AgentProcess> {
    const config = resolveAgent(agent);
    // `detached` puts the agent in its own process group, which buys two things.
    // The agent adapters spawn their own children (claude-agent-acp runs a
    // `claude` binary), and those children only get cleaned up by an exit handler
    // that does not run under SIGKILL — so killing the group is the only way to
    // avoid leaving a live grandchild reparented to init. It also stops a Ctrl-C
    // in the daemon's terminal from reaching every agent directly, which would
    // otherwise hide whether our own shutdown path actually works.
    const child = spawn(config.command, config.args, {
      // Secrets last, so a pasted token beats an ambient one: the Settings screen
      // says "set", and it has to be telling the truth about what the agent reads.
      env: { ...config.env, ...this.secrets(agent) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as PipedChild;
    // An agent that dies mid-write leaves an EPIPE on stdin. Unhandled, a stream
    // 'error' is fatal to the whole daemon.
    child.stdin.on("error", () => {});
    return new LocalAgentProcess(child);
  }

  /** git as a child of this daemon, against the repository where it lives. */
  git(): GitExec {
    return hostGit;
  }

  /**
   * Which binary a login drives, which is **not** the one {@link describe}
   * resolves.
   *
   * `available` is about `claude-agent-acp`, the ACP adapter this daemon spawns.
   * `loggedIn` and {@link login} are about `claude`, a different program that
   * ships as a platform-specific *optional* dependency of
   * `@anthropic-ai/claude-agent-sdk` with no `bin` entry. Conflating them is what
   * made an earlier documented remedy unrunnable: the adapter worked perfectly
   * and `claude` was not on PATH.
   *
   * **This mirrors the adapter's own `claudeCliPath()` rather than walking PATH,
   * and that ordering is the whole point.** Measured 2026-08-02: this daemon runs
   * under launchd with `PATH=/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:...`,
   * while `claude` was installed at `~/.local/bin/claude` — not on it. Sessions
   * worked, because the adapter resolves the vendored binary through the SDK and
   * never consults PATH; only the *probe* failed, so every agent reported
   * "signed in: cannot tell" with nothing saying why.
   *
   * Resolving the same binary the adapter will spawn is also the more correct
   * question, not merely the more available one: a login that wrote credentials
   * for a different build than the session reads is a login that appears to work
   * and changes nothing.
   *
   * PATH stays as the last resort, for an agent installed some other way and for
   * `kimi`, which has no vendored copy at all.
   *
   * **Codex is the same story, override and all.** Its adapter also brings its own
   * CLI (`@openai/codex`, a direct dependency), and the measured hazard is
   * identical: `codex` installs to `~/.local/bin` by default, which is exactly the
   * directory a launchd `PATH` does not have. It also has its own
   * `CLAUDE_CODE_EXECUTABLE` — `CODEX_PATH`, read by the adapter's
   * `startAcpServer()` — which is why the override is looked up from
   * `AGENT_LOGIN[agent].executableEnv` for **every** agent rather than under an
   * `agent === "claude"` test. Written as that test, codex's override chose the
   * binary sessions ran while this function kept resolving the vendored one.
   */
  private resolveLoginBinary(agent: AgentId): string | null {
    const overrideName = AGENT_LOGIN[agent].executableEnv;
    if (overrideName !== null) {
      const override = (process.env[overrideName] ?? "").trim();
      if (override.length > 0) return override;
    }
    const vendored = this.vendoredCli(agent);
    if (vendored !== null) return vendored;
    return findOnPath(AGENT_LOGIN[agent].command);
  }

  /**
   * The copy of an agent's CLI that its adapter brought with it, if it brought one.
   *
   * A `switch` with **no `default` arm**, so a fourth agent is a compile error here
   * rather than a silent `null`. The question it forces — "does this adapter vendor
   * the binary a login has to drive?" — is one whose wrong answer is invisible: the
   * login runs, writes credentials somewhere, and the session goes on reporting
   * logged out.
   */
  private vendoredCli(agent: AgentId): string | null {
    const cached = this.vendored.get(agent);
    if (cached !== undefined) return cached;
    let resolved: string | null;
    switch (agent) {
      case "claude":
        resolved = this.vendoredClaude();
        break;
      case "codex":
        resolved = this.vendoredCodex();
        break;
      case "kimi":
        // Installed globally and nowhere else; there is no copy to prefer.
        resolved = null;
        break;
    }
    this.vendored.set(agent, resolved);
    return resolved;
  }

  /**
   * The `codex` the adapter would spawn.
   *
   * Two hops like {@link vendoredClaude}, and easier at both: `@openai/codex` is a
   * *direct* dependency of the adapter rather than an optional platform variant, it
   * exports its own `package.json`, and it declares a real `bin` — so there is a
   * path to read rather than a platform-and-libc guess to make.
   *
   * **What it points at is a `#!/usr/bin/env node` launcher, not a native binary,
   * and that trades one dependency for another.** No platform to know here; but the
   * adapter runs that file as `spawn(process.execPath, [...])`, i.e. explicitly
   * *this* node, while a login hands the path to `script` and the shebang resolves
   * `node` from the unit's PATH. Those agree only because `runtime_path` puts
   * node's own directory on it — see the PATH section of `CLAUDE.md`.
   * {@link vendoredClaude} has no such dependency, because what it finds is
   * executable on its own.
   *
   * `bin` is normalized because npm allows both spellings: a bare string means "one
   * binary, named after the package".
   */
  private vendoredCodex(): string | null {
    try {
      const fromHere = createRequire(import.meta.url);
      const adapter = fromHere.resolve("@agentclientprotocol/codex-acp/package.json");
      const manifestPath = createRequire(adapter).resolve("@openai/codex/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["codex"];
      if (entry === undefined) return null;
      const resolved = join(dirname(manifestPath), entry);
      return existsSync(resolved) ? resolved : null;
    } catch {
      // No adapter, or a layout that moved. `findOnPath` is the fallback.
      return null;
    }
  }

  /**
   * The `claude` the adapter would spawn, resolved the way the adapter does it.
   *
   * A `require` bound to the SDK rather than to this file, because pnpm's strict
   * layout means the root cannot resolve a transitive dependency — the same
   * reason `token.ts` is hand-rolled on `node:crypto` instead of using `jose`.
   *
   * Linux ships glibc and musl variants that can sit side by side, and picking
   * the wrong one segfaults at runtime rather than failing to spawn. Both are
   * tried; the adapter additionally sniffs libc to choose an order, which is a
   * refinement worth having only if this ever runs somewhere it matters.
   */
  private vendoredClaude(): string | null {
    let resolved: string | null = null;
    try {
      const fromHere = createRequire(import.meta.url);
      const sdk = fromHere.resolve("@anthropic-ai/claude-agent-sdk", {
        paths: [fromHere.resolve("@agentclientprotocol/claude-agent-acp/package.json")],
      });
      const fromSdk = createRequire(sdk);
      const ext = process.platform === "win32" ? ".exe" : "";
      const candidates =
        process.platform === "linux"
          ? [
              `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
              `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            ]
          : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
      for (const candidate of candidates) {
        try {
          resolved = fromSdk.resolve(candidate);
          break;
        } catch {
          // Try the next variant; absent entirely is a legitimate install.
        }
      }
    } catch {
      // No adapter, or no SDK under it. `findOnPath` is the fallback.
    }
    return resolved;
  }

  private scriptPath(): string | null {
    if (this.scriptResolved === undefined) this.scriptResolved = findOnPath("script");
    return this.scriptResolved;
  }

  /**
   * Why "signed in" could not be answered, when it could not be.
   *
   * `null` whenever there is nothing useful to say — the agent is signed in, or
   * it simply has no way to be asked. Kimi is the second case by construction: it
   * publishes no non-interactive status command, so "cannot tell" there is the
   * permanent, correct answer and dressing it up as a problem would send somebody
   * looking for a fault that is not there.
   */
  private cannotAskHint(agent: AgentId, loggedIn: boolean | null): string | null {
    if (loggedIn !== null) return null;
    if (AGENT_LOGIN[agent].status === null) return null;
    if (this.resolveLoginBinary(agent) !== null) return null;
    const overrideName = AGENT_LOGIN[agent].executableEnv;
    // Named from the table rather than written out, because an agent that has no
    // such variable used to be told to set claude's.
    const remedy =
      overrideName === null
        ? `Put it on this daemon's PATH`
        : `Set ${overrideName} to the binary you log in with, or put it on this daemon's PATH`;
    return (
      `${AGENT_LOGIN[agent].command} could not be found, so this daemon cannot tell whether ` +
      `${agent} is signed in — sessions may still work, because the adapter resolves its own ` +
      `copy. ${remedy} (a service does not read your shell profile).`
    );
  }

  /** The cached half of the probe: TTL, in-flight collapse, generation fence. */
  private async loginState(agent: AgentId, generation: number): Promise<boolean | null> {
    const cached = this.loginProbed.get(agent);
    if (cached !== undefined && Date.now() - cached.at < LOGIN_PROBE_TTL_MS) return cached.value;

    const running = this.loginInFlight.get(agent);
    if (running !== undefined) return running;

    const probe = this.readLoginState(agent)
      .then((value) => {
        // Only if nothing cleared the cache while we were asking. Writing a
        // pre-clear answer back is precisely how a fresh login stays invisible.
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
   * Is this agent signed in — `true`, `false`, or `null` for "cannot tell".
   *
   * Three answers for the same reason {@link Liveness} has three, and the third
   * is not a hedge: kimi has no non-interactive way to say, and rendering "cannot
   * tell" as "logged out" puts a login wizard in front of somebody whose agent
   * works perfectly.
   *
   * For claude and codex the answer comes from the CLI's own status command, in
   * whichever format that CLI speaks — `{"loggedIn": …}` from `claude auth status`,
   * a sentence from `codex login status`. {@link readLoginAnswer} owns the reading
   * of both, including why neither is read by its exit code.
   *
   * For kimi it is the credential file, and that test is deliberately
   * **one-directional**: presence proves a login happened, absence proves
   * nothing, because the layout is kimi's to change. Measured, an installation
   * that has run kimi but never logged in has `~/.kimi-code/{device_id,
   * config.toml,logs}` and no `credentials/` at all.
   *
   * A pasted credential is the fallback and not the first word: the probe runs
   * with the token already in its environment, so an agent that still says no is
   * saying something worth believing and a clean `false` wins. Only "cannot tell"
   * falls back to it.
   */
  private async readLoginState(agent: AgentId): Promise<boolean | null> {
    const spec = AGENT_LOGIN[agent];
    const pasted = Object.keys(this.secrets(agent)).length > 0;

    if (spec.status !== null) {
      const command = this.resolveLoginBinary(agent);
      if (command === null) return pasted ? true : null;
      const answer = await this.probe(command, spec.status.args, agent, spec.status.stream);
      // Believed either way, pasted credential or not. The probe above ran *with*
      // that credential, so a `false` here is the agent having seen it and still
      // saying no — which is worth more than our knowing we handed one over. Only
      // "cannot tell" falls back, below.
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

  /**
   * One bounded, non-interactive question to a CLI. `null` means no answer.
   *
   * **Run with the pasted credential in its environment**, which is what makes
   * the asymmetry in {@link readLoginState} honest. It did not, and the docblock
   * there asserted that it did: `runProbe` passed no `env`, so it inherited this
   * daemon's, and a token that lives in SQLite and is merged only at spawn was
   * invisible to it. So "the agent has seen the token and still says no" was
   * describing something that had never happened, and a wrong or expired pasted
   * token reported `loggedIn: true` — the Settings screen said signed in and the
   * first session answered `502 agent_auth_required`, which is the exact failure
   * this probe was added to prevent.
   */
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

  /**
   * `"unknown"` is reachable here and used to be unreachable *by construction*,
   * because the probe collapsed `EPERM` into `ESRCH`. See {@link isAlive}.
   */
  async alive(handle: AgentHandle | null): Promise<Liveness> {
    if (handle?.kind !== "local") return "dead";
    return isAlive(handle.pid);
  }

  /**
   * Kills an agent the previous daemon left behind.
   *
   * Fenced on `os.uptime()`: a session created before this boot names a pid from
   * a numbering that has since been reset, so it is left alone.
   *
   * **That fence covers a reboot and nothing else, which is worth stating rather
   * than overclaiming.** Pids also wrap *within* a boot, and sessions are retained
   * for seven days, so a busy host can recycle a number while the row that names
   * it is still live. Closing that would mean recording the agent's start time at
   * spawn and comparing it against `/proc/<pid>/stat` or `ps -o lstart` before
   * signalling — a real answer, not built, and this comment used to claim the
   * weaker fence was the stronger one.
   *
   * We do not wait to confirm the death, because `restore()` has to stay
   * synchronous. An unconfirmed kill is reported as `agentConfirmedDead: false`,
   * which is exactly what that field means — we asked, we did not watch it die.
   *
   * Not optional polish: `claude-agent-acp` runs the `claude` CLI as its own child
   * and cleans up only via `process.on("exit")`, which does not run under SIGKILL.
   * A crashed daemon is the likeliest way to strand a grandchild holding a cwd.
   */
  reap(handle: AgentHandle | null, createdAt: number, enabled: boolean): ReapDecision {
    if (handle === null) {
      return { killed: false, confirmedDead: true, detail: "the daemon restarted; no agent was recorded" };
    }
    if (handle.kind !== "local") {
      // A row written by the other runtime. Nothing here can signal it, and
      // guessing would mean signalling a host pid that means something else.
      return {
        killed: false,
        confirmedDead: false,
        detail: "the daemon restarted; the recorded agent was not a local process and was left alone",
      };
    }
    const { pid } = handle;
    // Only a *definite* death confirms. `"unknown"` means the probe could not
    // ask — `EPERM`, i.e. that pid belongs to somebody else now — and treating
    // that as gone is what marks a row terminal so no later boot looks again.
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

/**
 * Signals a whole process group, falling back to the process alone.
 *
 * The group is the point: agents spawn their own children, and signalling only
 * the one we know about leaves those behind.
 */
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

/**
 * Three answers, because `process.kill(pid, 0)` has three outcomes.
 *
 * **This returned a boolean, and the boolean was the bug `Liveness` exists to
 * make unsayable.** It swallowed the errno, so `EPERM` — "the process is there
 * and it is not yours to signal" — came back identical to `ESRCH`, which is
 * "gone". Those are opposite facts, and reporting the first as the second is what
 * writes `agentConfirmedDead: true` for an agent that is still running, which
 * also makes the row terminal so the *next* boot's reaper skips it too.
 *
 * Reachable on this runtime rather than theoretical: the reap path signals a pid
 * recorded by a previous daemon, and after a crash and enough process churn that
 * number can belong to somebody else's process, which is exactly `EPERM`.
 *
 * Anything that is not `"dead"` is still worth signalling — the kill will simply
 * fail, harmlessly, which is a better outcome than not trying.
 */
/**
 * The real probe: one bounded, non-interactive question to a CLI.
 *
 * A free function rather than a method so `LocalRuntimeOptions.exec` can stand in
 * for it. That seam exists because this is the only part of the login path a
 * driver cannot otherwise reach — the answer comes from a binary that is not
 * installed on a CI machine, and the branches that matter are precisely the ones
 * about *disagreeing with the exit code*: `claude auth status` prints
 * `{"loggedIn": false}` and exits 1, so a probe that read the status would report
 * a crash and a logged-out agent identically.
 */
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
        // Exit 1 is an answer for both status commands, so the callback's error is
        // not consulted for anything but "there is no output at all".
        const text = (stream === "stderr" ? stderr : stdout).toString().trim();
        if (text.length > 0) return resolve(text);
        resolve(error === null ? "" : null);
      },
    );
  });
}

/**
 * What a CLI's own "am I signed in" output says — `true`, `false`, or `null`.
 *
 * Pure and exported for the reason {@link hostLoginArgs} is: the branches that
 * matter here are unreachable from a machine that has neither CLI installed, and
 * each of them is a way to be wrong *quietly*. The third answer is the point —
 * anything this cannot read is "cannot tell", never "logged out", because a
 * logged-out badge in front of somebody whose agent works sends them to redo a
 * login that was fine.
 *
 * **Neither arm reads an exit code**, and both agents that answer at all exit 1
 * when logged out, so the code does track the answer. It is still not read: a
 * non-zero exit is indistinguishable from a crash, a missing binary, or a future
 * version failing for its own reasons.
 *
 * The text arm tests `signedOut` **first**. The patterns are anchored so neither
 * can match the other's line today, but "Logged in" is a substring of "Not logged
 * in" and the ordering is what keeps that from mattering if either is ever
 * loosened.
 */
export function readLoginAnswer(probe: LoginStatusProbe, answer: string): boolean | null {
  if (probe.reads === "json") {
    try {
      const parsed = JSON.parse(answer) as { loggedIn?: unknown };
      if (parsed.loggedIn === true) return true;
      if (parsed.loggedIn === false) return false;
    } catch {
      // Not JSON. A future version, or an error on stdout — either way this is
      // the "cannot tell" case and not the "logged out" one.
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
