import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, uptime as osUptime } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  AGENT_LOGIN,
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

/**
 * How long "which build of this CLI runs here" is reused.
 *
 * ⚠ **Deliberately not {@link LOGIN_PROBE_TTL_MS}, and the difference is what the
 * two facts are *about*.** Three seconds is the tempo of a person signing in and
 * expecting a screen to change. A CLI build changes when a background updater
 * lands one — `~/.local/share/claude/versions/` gains a directory and the launcher
 * is repointed — which is hours apart, and each answer costs a `--version` per
 * harness. At three seconds that is a subprocess per harness every few seconds for
 * a number that moves twice a week.
 *
 * The same ten minutes as `MODELS_TTL_MS`, and that is the honest pairing rather
 * than a coincidence: the model list is what this decides, so the two halves of
 * one screen do not go stale on different clocks.
 *
 * Non-zero rather than a per-process memo for the reason the memo it sits beside
 * is cleared: a self-updating CLI moves under a running daemon, and an answer held
 * for the life of the process would pin the model list to whatever was installed
 * at boot.
 */
const AGENT_CLI_TTL_MS = 10 * 60_000;

/** How long a status command may take before it is treated as no answer. */
const LOGIN_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long a refused start is remembered against the harness that refused it.
 *
 * ⚠ **The expiry is not a tidiness measure — it is what makes the whole record
 * safe, and it is why the list of things that clear one does not have to be
 * exhaustive.** An observation ages; a verdict does not. Everything else here can
 * be got wrong without stranding anybody: somebody who signs in by running the
 * CLI in a terminal on the machine itself has told this daemon nothing, and no
 * hook, route or control can be relied on to notice. What can be relied on is
 * that the record stops being believed.
 *
 * `MODELS_TTL_MS`'s number and `MODELS_TTL_MS`'s argument, deliberately: that is
 * the other fact here that costs a spawn to re-measure and is re-measured by the
 * same spawn, so the two ageing at different rates would let the model picker and
 * the New session strip disagree about the same harness on the same machine.
 * Emphatically **not** {@link LOGIN_PROBE_TTL_MS}: three seconds is a cache in
 * front of a question this daemon can ask whenever it likes, and this is a
 * question it can only ask by starting a session somebody asked for.
 */
export const START_REFUSAL_TTL_MS = 10 * 60_000;

/**
 * The most of a refusal that is kept.
 *
 * The message is built from the agent's `displayName` and its `authHint`, and for
 * a harness a plugin added both of those are the manifest's prose — so this is
 * `boundedName`'s argument at the other end of the wire: a value somebody else
 * wrote, on its way to a settings card that reserved a paragraph. Bounded here,
 * where it is *stored*, rather than at the throw: the sentence that reaches a
 * `502` is unchanged and uncut, because that one is read once by whoever pressed
 * Start and this one is drawn on every listing for the next ten minutes.
 */
export const MAX_START_REFUSAL_CHARS = 512;

/**
 * Whether a refused start is still worth believing.
 *
 * ⚠ **Pure and exported so a driver can reach the expiry without a clock being
 * injected into the runtime.** `LocalRuntimeOptions` takes `exec` and `secrets`
 * and neither is a test hook — both are seams something in production needs — so
 * a `now` beside them would be the first, and it would sit on the class whose
 * whole subject is spawning programs. The rule that matters is arithmetic, and
 * arithmetic can be a function.
 *
 * `<` rather than `<=`: at exactly the budget the answer is stale, which is the
 * same boundary `loginState`'s own cache test takes.
 */
export function startRefusalLive(held: StartRefusal, now: number): boolean {
  return now - held.at < START_REFUSAL_TTL_MS;
}

/**
 * The first dotted number in a `--version` line, or `null`.
 *
 * The CLIs do not agree on the shape of that line — `2.1.259 (Claude Code)` puts
 * it first, `codex-cli 0.146.1` puts it last — so it is found wherever it sits
 * rather than by position. Deliberately **not** a full semver parse: what is being
 * answered is "which build is this", for a line under a model list that somebody
 * compares against their own `--version`, and a pre-release suffix or a fourth
 * component is noise against that. It used to decide a comparison too — the copy on
 * PATH against one this repository vendored — and that comparison went with the
 * vendored copies (Q4.114); what is left is the report.
 */
export function firstVersion(text: string): string | null {
  /*
   * ⚠ **A lookbehind rather than `\b`, and the difference is a shipped bug.** `\b`
   * sits between a *word* character and a non-word one, and a letter and a digit
   * are both word characters — so `v2.1.259` had its first boundary after the `2`
   * and the whole thing read as `1.259`, a version older than almost anything it
   * would be compared against. Anchored on "not preceded by a digit or a dot"
   * instead, which is what "the start of a number" actually means here.
   */
  return /(?<![\d.])(\d+(?:\.\d+)+)/.exec(text)?.[1] ?? null;
}

/**
 * Where a chosen CLI goes on the spawn, or nowhere.
 *
 * Pure and exported for the reason {@link firstVersion} is: `launch` is the one
 * place these arms meet, every driver that reaches a session overrides `launch`,
 * and so the arms had no witness. The block in
 * {@link LocalRuntime.launch} is the argument for each; this is the decision.
 *
 * - `overrideName` set: the vendor's variable is written and the command is left
 *   alone — the adapter resolves a CLI of its own, and naming that CLI as the
 *   command would spawn a coding agent where an ACP server is expected. Written
 *   for an override too, though it is already in the environment: saying it is
 *   what makes the spawn's environment the whole answer to "which build".
 * - `overrideName` null: the harness *is* the program, so the command is replaced.
 * - no choice at all: a contributed harness, or a built-in with no CLI on the
 *   machine — left entirely alone. For the second `describe` has already refused,
 *   and {@link LocalRuntime.agentCli} never holds a miss, so the first launch after
 *   an install finds the file rather than a cached "none".
 *
 * ⚠ **There used to be a fourth arm — a vendored copy, under which nothing was
 * written because the adapter resolved that same file itself.** It went with the
 * vendored copies (Q4.114); every copy that runs now is named out loud.
 */
export function spawnPlan(
  command: string,
  chosen: AgentCliChoice | null,
  overrideName: string | null,
): { command: string; env: NodeJS.ProcessEnv } {
  if (chosen === null) return { command, env: {} };
  if (overrideName === null) return { command: chosen.path, env: {} };
  return { command, env: { [overrideName]: chosen.path } };
}

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
  /**
   * Whether this agent has a sign-in at all — {@link hasLoginFlow}.
   *
   * ⚠ **No default, deliberately.** It had one, `true`, and a defaulted "this agent
   * has a sign-in" is a wrong answer that arrives silently at the next caller: the
   * only agent it is false for is the only one that would never be noticed, since
   * everything about it looks like an ordinary agent that simply has not been
   * signed in yet. Every call site says which it means.
   */
  hasFlow: boolean,
): "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null {
  /*
   * ⚠ **First, because it is the only one that is not a limitation.** The other
   * three say a sign-in could not be run *here* — a missing `script`, a missing
   * CLI, a pty this OS will not give a background service — and each has a remedy.
   * This one says the agent needs no sign-in at all, which is good news and must
   * not be ordered after a sentence apologising for the host: a machine with no
   * `script` would otherwise be told it cannot run a wizard that does not exist.
   */
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
  /**
   * This user's pasted credentials for an agent, as environment variables.
   *
   * A function rather than a map so the runtime never holds the secrets, and
   * injected rather than read here so it never learns about SQLite. Read at
   * launch rather than captured, so replacing a token takes effect on the next
   * session without a daemon restart.
   */
  secrets?: (agent: AgentId) => Record<string, string>;
  /**
   * This user's credential for a *system*, read the same way and for the same
   * reasons — never held here, never captured, so replacing a key takes effect
   * on the next session.
   *
   * Separate from {@link secrets} because the two never mix: an agent credential
   * is merged into an environment, a system credential is handed to
   * `providers/set` over stdio and must not be.
   */
  systemSecret?: (system: SystemId) => string | null;
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
  /**
   * What this machine offers beyond what this repository ships.
   *
   * ⚠ **Injected rather than imported, and it is the same seam `secrets` is.**
   * The catalogue is assembled from installed plugin manifests, which is a fact
   * about a database this runtime deliberately knows nothing about — and a
   * driver that wants a contributed harness stands one in here rather than
   * building a plugin tree on disk.
   *
   * Defaulted to {@link BUILTIN_CATALOGUE}, so every existing caller — the
   * drivers, `scripts/harness.ts`, and this class before there were plugins —
   * behaves exactly as it did.
   */
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
  private readonly machine: MachineCatalogue;

  /** Memoised: `script` does not appear and disappear during a daemon's life. */
  private scriptResolved: string | null | undefined;
  /**
   * Which build each harness resolved to, and when it was decided.
   *
   * On a clock rather than for the process, because the file it names is the one
   * thing under this daemon that moves without a restart — `deploy/agents.sh`
   * repoints it daily. See {@link agentCli}.
   */
  private readonly cliChosen = new Map<AgentId, { at: number; value: AgentCliChoice }>();

  /**
   * One decision in flight per harness, for `loginInFlight`'s reason: a restart
   * launches every interrupted session at once and each of them asks, the
   * capability sweep asks beside them, and N askers arriving on a cold cache were
   * N `--version` spawns of one file.
   */
  private readonly cliInFlight = new Map<AgentId, Promise<AgentCliChoice | null>>();

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

  /**
   * What each harness said the last time it refused to open a session.
   *
   * ⚠ **Beside the probe's cache and under neither of its rules.** It is not
   * cleared by `forgetAvailability()` — three of that method's five callers are a
   * credential being taken *away*, and losing a key is not evidence that a
   * harness which would not start now would — and it does not expire on
   * `LOGIN_PROBE_TTL_MS`, which is three seconds in front of a question this
   * daemon can ask for the price of a `--version`. This one costs a session
   * somebody asked for, so it ages on {@link START_REFUSAL_TTL_MS} instead.
   *
   * ⚠ **In memory, per daemon, and durability was rejected rather than skipped.**
   * Q7.99 is the recorded case of exactly this fact written down and believed
   * afterwards — `stop("agent_signed_out")` off one observation, which stranded
   * conversations under a notice that was already false. A restart is also when
   * the machine has most likely changed underneath it, so surviving one would
   * make the record most wrong exactly where it was most persistent.
   */
  private readonly startRefused = new Map<AgentId, StartRefusal>();

  constructor(options: LocalRuntimeOptions = {}) {
    this.secrets = options.secrets ?? (() => ({}));
    this.systemSecretOf = options.systemSecret ?? (() => null);
    this.onWarning = options.onWarning ?? (() => {});
    this.exec = options.exec ?? ((command, args, env, stream) => runProbe(command, args, env, stream));
    this.machine = options.machine ?? BUILTIN_CATALOGUE;
  }

  /**
   * This agent's row in {@link AGENT_LOGIN}, or `null` for one a plugin added.
   *
   * ⚠ **One place the absence is decided, because it is decided *nine* times
   * below and every one of them used to be a total index.** A contributed
   * harness has no login argv, no logout verb, no status probe and no credential
   * path — deliberately, per `HarnessContribution` — so `null` here is not a
   * missing measurement, it is opencode's shipped shape reached by a different
   * door. Each caller answers it in the way its own screen needs.
   */
  private builtinLogin(agent: AgentId): (typeof AGENT_LOGIN)[BuiltinAgentId] | null {
    return isBuiltinAgentId(agent) ? AGENT_LOGIN[agent] : null;
  }

  /**
   * Which variables a pasted credential for this harness is written to.
   *
   * The `credentialEnvNames` of a built-in, the manifest's `envNames` for a
   * contributed harness, and `[]` for one this machine does not offer — which is
   * what makes `PUT /agent-auth/:agent` refuse a slot rather than invent one.
   */
  credentialSlots(agent: AgentId): readonly string[] {
    const builtin = this.builtinLogin(agent);
    if (builtin !== null) return builtin.envNames;
    return this.machine.harness(agent)?.envNames ?? [];
  }

  /** What this machine offers, for the routes and for `Session`'s launch options. */
  get catalogue(): MachineCatalogue {
    return this.machine;
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
    return resolveAgent(agent, this.machine);
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
    /*
     * ⚠ **The built-ins first, then whatever plugins added — and a *disabled*
     * plugin's harness is not here at all.** `harnessIds()` answers what this
     * machine offers right now, so a tile that starts nothing is never drawn and
     * `POST /sessions` never has to explain a row this screen put in front of
     * somebody. What a switched-off plugin's harness keeps is its *position*, in
     * `agent_strip`, which is never validated against anything.
     */
    return Promise.all(
      this.machine.harnessIds().map(async (id): Promise<AgentAvailability> => {
        const contributed = this.machine.harness(id);
        // The label, and never `displayName`, which carries the program name for a
        // log line — see `contributedLaunchConfig`.
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
            // A contributed harness that will not resolve is still called
            // something: falling back to the bare id here would put `acme:gemini`
            // in the settings list beside `Kimi Code CLI`.
            displayName: contributed?.name ?? id,
            available: false,
            hint: describeError(error),
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
          ...extra,
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
          lastStartRefusal: this.startRefusal(id),
        };
      }),
    );
  }

  /**
   * See {@link SessionRuntime.noteStartRefusal}.
   *
   * Clipped here rather than at the throw, because this is where the string stops
   * being a one-off answer to whoever pressed Start and becomes a field on every
   * listing for the next ten minutes. See {@link MAX_START_REFUSAL_CHARS}.
   */
  noteStartRefusal(agent: AgentId, message: string, routed: boolean): void {
    this.startRefused.set(agent, {
      at: Date.now(),
      routed,
      message: message.slice(0, MAX_START_REFUSAL_CHARS),
    });
  }

  /** See {@link SessionRuntime.forgetStartRefusal}. */
  forgetStartRefusal(agent?: AgentId): void {
    if (agent === undefined) this.startRefused.clear();
    else this.startRefused.delete(agent);
  }

  /**
   * The live refusal for one harness, **expired on read**.
   *
   * Deleting rather than filtering is what keeps the map from being a second
   * source of truth: nothing anywhere else has to know the budget, and a stale
   * entry cannot survive to be read by a future caller that forgot to check it.
   * It is also why {@link START_REFUSAL_TTL_MS} never reaches the wire — a client
   * is handed a refusal or nothing, and has no arithmetic of its own to get
   * wrong.
   */
  private startRefusal(agent: AgentId): StartRefusal | null {
    const held = this.startRefused.get(agent);
    if (held === undefined) return null;
    if (startRefusalLive(held, Date.now())) return held;
    this.startRefused.delete(agent);
    return null;
  }

/*
 * `signedOut(agent)` used to live here, and it is gone rather than kept.
 *
 * It answered "is this agent known signed out" for a guard on the prompt path,
 * and that guard was the wrong shape: it spawned the agent's CLI on the hot path,
 * was only ever as fresh as its 3s cache, and — the reason it was removed —
 * made every offline driver depend on whether the person running it was signed
 * in. A stub runtime inherits this class, and `resolveLoginBinary` found the copy
 * this repository vendored then, so CI (signed in to nothing) refused a prompt two
 * assertions expected to land.
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
    /*
     * ⚠ **The CLI choice too.** The daily agent update is one of this method's
     * callers, and it is the event that moves the file a choice names: a memo held
     * past this point is the build the updater has just replaced, run for another
     * ten minutes while the fresh one sits on disk.
     */
    this.cliChosen.clear();
    // And a decision still in flight, which the generation fence keeps out of the
    // cache but which `agentCli` would go on handing to every caller arriving in
    // the seconds a `--version` takes — the pre-update answer, after the update.
    // Its own `finally` only deletes the entry it still owns, so this is safe to
    // clear under it.
    this.cliInFlight.clear();
    // And the PATH walk's own memo, which is module-level and outlives every map
    // here: a hit never expires, and the daily agent update is the one event that
    // puts a binary where there was none.
    forgetPathHits();
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
    // Nothing to run. `loginSupport` already says so, and the route refuses before
    // reaching here — this is the same answer said where the spawn would be.
    //
    // ⚠ **A contributed harness reaches this too, through `null` rather than
    // through `args: null`, and the answer has to be the same one.** It has no
    // login table row at all, so there is no argv to spawn — which is opencode's
    // shipped position reached by a different door, not a gap.
    const login = this.builtinLogin(agent);
    const flow = login?.args ?? null;
    if (login === null || flow === null) return null;
    const script = this.scriptPath();
    if (script === null) return null;
    // The *chosen* build, not merely a resolvable one — a login that wrote its
    // credential through a different binary than sessions run is the failure
    // `agentCli`'s docblock exists to prevent, and it reports success while it
    // happens.
    const chosen = await this.agentCli(agent);
    const command = chosen?.path ?? null;
    if (command === null) {
      this.onWarning(`cannot log ${agent} in: ${login.command} is not on PATH`);
      return null;
    }
    const spec = hostLoginArgs(process.platform, command, flow, script);
    const stdin = loginStdio(process.platform, login.interactiveStdin);
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
    const login = this.builtinLogin(agent);
    /*
     * ⚠ **A contributed harness answers `no_flow`, and it must answer *something*
     * rather than be left absent.** `agentStance` reads this: with no `login`
     * object at all it falls to `unchecked`, and every contributed harness in the
     * fleet would carry a permanent "cannot check" badge — a sentence about a probe
     * that failed, over an agent that runs perfectly. `no_flow` is the one reason
     * in that vocabulary that is a fact about the *agent* rather than about the
     * host, which is exactly what this is.
     */
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
    // `null` for a contributed harness for the same reason it is `null` for kimi:
    // there is no sign-out verb, so there is no button. The two arrive here by
    // different routes and mean the same thing to every caller.
    const login = this.builtinLogin(agent);
    const args = login?.logoutArgs ?? null;
    if (login === null || args === null) return null;
    // The same build the login drove and a session runs — see `login` above.
    const command = (await this.agentCli(agent))?.path ?? null;
    if (command === null) {
      return { ok: false, detail: `${login.command} is not on this daemon's PATH` };
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

  systemSecret(system: SystemId): string | null {
    return this.systemSecretOf(system);
  }

  async launch(agent: AgentId, extra: NodeJS.ProcessEnv = {}, routed = false): Promise<AgentProcess> {
    const config = resolveAgent(agent, this.machine);
    /*
     * **Which build the session runs, said out loud rather than left to whatever
     * the adapter finds — and the adapter finds nothing on its own any more.** See
     * {@link agentCli} for how it is chosen; what this does is put that answer
     * where the spawn can act on it, and the two shapes are not interchangeable:
     *
     * - claude and codex spawn an *adapter*, which then resolves a CLI of its own.
     *   The only way in is the vendor's own variable — so it is written into the
     *   child's environment and `config.command` is left alone. Writing the CLI
     *   there instead would spawn a coding agent where an ACP server is expected.
     *   ⚠ And it is the *only* way in now: the platform package the adapter would
     *   otherwise `require` is excluded from `node_modules` (Q4.114), so with the
     *   variable unset claude's adapter throws at start and codex's spawns a shim
     *   that exits. Two things keep a spawn from reaching here without a choice:
     *   `describe` refuses first, with a sentence, and `agentCli` never caches a
     *   miss, so the walk that `describe` just made is the walk this makes.
     * - opencode and kimi *are* the program, so the command is replaced and there
     *   is no variable to write. `AGENT_LOGIN[*].executableEnv` is what tells the
     *   two apart, which is the same field `resolveLoginBinary` reads — a harness
     *   that grows one is handled by the first arm without a second edit here.
     *
     * Measured in `codex-acp` 1.1.9 and still worth knowing: with `CODEX_PATH` set
     * it spawns the path directly, so a `#!/usr/bin/env node` launcher — which is
     * what `--source npm` puts at `~/.reemoat/toolchain/bin/codex` — resolves `node`
     * against the unit's PATH. `runtime_path` puts the toolchain's node there, which
     * is the same dependency kimi has had all along.
     *
     * A contributed harness answers `null` and is left entirely alone: what a
     * manifest names is a program on PATH.
     */
    const chosen = await this.agentCli(agent);
    const { command, env: cliEnv } = spawnPlan(config.command, chosen, this.builtinLogin(agent)?.executableEnv ?? null);
    // `detached` puts the agent in its own process group, which buys two things.
    // The agent adapters spawn their own children (claude-agent-acp runs a
    // `claude` binary), and those children only get cleaned up by an exit handler
    // that does not run under SIGKILL — so killing the group is the only way to
    // avoid leaving a live grandchild reparented to init. It also stops a Ctrl-C
    // in the daemon's terminal from reaching every agent directly, which would
    // otherwise hide whether our own shutdown path actually works.
    const child = spawn(command, config.args, {
      // Secrets last, so a pasted token beats an ambient one: the Settings screen
      // says "set", and it has to be telling the truth about what the agent reads.
      //
      // `extra` last of all, and it is *not* a third secret channel — see
      // `SessionRuntime.launch`. It carries what this daemon's own tables
      // produced, which today is the model a routed system is pinned to. It
      // outranks an ambient `ANTHROPIC_MODEL` deliberately: a session created as
      // "Claude Code on Kimi K2" has to run K2 whatever this host's shell
      // profile happens to export.
      /*
       * ⚠ **A routed session is spawned without the harness's own credentials.**
       * `secrets(agent)` merges what somebody pasted for *this harness* — for
       * claude that is `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` — and on a
       * routed pairing the session is about to be aimed at another vendor's
       * endpoint on a *different* key. `claude-agent-acp` 0.63.0 sets
       * `ANTHROPIC_AUTH_TOKEN: " "` for exactly that reason: no Anthropic
       * credential is needed there. It does not delete the two above it, and this
       * daemon was still putting them in, so the process pointed at a third party
       * carried a vendor credential it had no use for — with the destination
       * author-chosen once a plugin may contribute a provider.
       *
       * Whether the CLI would actually *send* it to a foreign `ANTHROPIC_BASE_URL`
       * is a precedence question inside a stripped binary and is deliberately not
       * relied on here: this daemon should not hand a credential to a process it is
       * simultaneously aiming somewhere else, whichever way that resolves.
       *
       * ⚠ **Not a fence, and the section in `CLAUDE.md` still holds.** The agent
       * runs as this uid and can read `REEMOAT_DB`. What this removes is the
       * accident, on the one path where the credential has no purpose at all.
       */
      /*
       * `cliEnv` before `extra`, so a caller that passes the vendor's variable
       * explicitly still wins — the same precedence `chooseCli` gives the
       * operator's own environment, applied one layer down.
       */
      env: { ...config.env, ...cliEnv, ...(routed ? {} : this.secrets(agent)), ...extra },
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
   * Whether *any* binary exists for this harness — an existence test, and not the
   * answer to which one runs.
   *
   * ⚠ **This used to decide which binary a login drove, and that decision moved to
   * {@link agentCli}.** The two synchronous callers left — `loginSupport` and
   * `cannotAskHint` — compare its answer to `null` and nothing else, so what it
   * has to get right is only "is there one at all": an override counts, a copy on
   * PATH or in `MANAGED_CLI_DIRS` counts. Which of them a login, a logout, a status
   * probe or a session actually runs is `chooseCli`'s answer, and every caller that
   * consumes a *path* is async and goes through it — which is what keeps a login
   * and a session from picking differently, the failure `agentCli`'s docblock is
   * about.
   *
   * The override is looked up from `AGENT_LOGIN[agent].executableEnv` for
   * **every** agent rather than under an `agent === "claude"` test, because two of
   * the four have one: `CLAUDE_CODE_EXECUTABLE`, and codex's `CODEX_PATH`, read by
   * the adapter's `startAcpServer()`. Written as that test, codex's override chose
   * the binary sessions ran while this function kept resolving another.
   *
   * Measured 2026-08-02 and the reason `MANAGED_CLI_DIRS` exists: this daemon runs
   * under launchd with `PATH=/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:...`,
   * while `claude` was installed at `~/.local/bin/claude` — not on it. Then, the
   * adapter resolved a copy this repository vendored and only the *probe* failed,
   * so every agent reported "signed in: cannot tell" with nothing saying why. Now
   * there is no vendored copy (Q4.114), `resolveAgent` refuses the harness outright
   * on the same absence, and the sentence it refuses with names the remedy.
   */
  private resolveLoginBinary(agent: AgentId): string | null {
    /*
     * ⚠ **`null` for a contributed harness, and that is a refusal rather than a
     * gap.** `executableEnv` is one of the fields a manifest may not declare —
     * this function reads it for *every* agent, so a manifest naming
     * `CLAUDE_CODE_EXECUTABLE` would redirect which binary somebody else's login
     * drives. With no login to drive there is no binary to resolve, and every
     * caller already reads `null` as "cannot": `loginSupport` answers `no_flow`
     * above this, so nothing reaches here expecting otherwise.
     */
    const login = this.builtinLogin(agent);
    if (login === null) return null;
    const overrideName = login.executableEnv;
    if (overrideName !== null) {
      const override = (process.env[overrideName] ?? "").trim();
      if (override.length > 0) return override;
    }
    return findOnPath(login.command);
  }

  /**
   * Which build of an agent's CLI this daemon runs, and why that one.
   *
   * **Two sources, in order of authority:**
   * - `override` — `AGENT_LOGIN[agent].executableEnv` is set. It wins outright,
   *   because `agentEnv` preserves those names precisely on the grounds that *an
   *   operator who set one meant it*.
   * - `path` — otherwise the first copy `findOnPath` finds: PATH in order, then
   *   `MANAGED_CLI_DIRS`, which is where `deploy/agents.sh` installs. So a copy of
   *   the operator's own on PATH outranks the one this daemon keeps current, and
   *   the script agrees from its side: a copy it did not install — outside the
   *   vendors' directories and its own toolchain — is named and not moved, and one
   *   it did install is refreshed through the door it came in by, whatever
   *   `--source` says today.
   *
   * ⚠ **There was a third, and a comparison, and both are gone (Q4.114).** The
   * adapters used to bring a pinned CLI with them under `node_modules`, exactly as
   * old as the release — measured 2026-09-03, adapter 0.63.0 vendored claude
   * **2.1.220**, which publishes `claude-fable-5[1m]` where a 2.1.259 publishes
   * `claude-fable-5-1[1m]` — so this weighed `--version` of the copy on PATH
   * against it and ran the newer. With no stale floor there is nothing to weigh:
   * every copy on the machine is one somebody installed or one the daily refresh
   * keeps moving, and "first found" is the predictable answer. What is still read
   * is the version, for the report — `AgentCapabilities.cli` names the build under
   * the model list it published — and a binary that will not say which build it is
   * still runs, with `version: null`.
   *
   * ⚠ **Cached on {@link AGENT_CLI_TTL_MS} rather than for the process, and that
   * is the whole point rather than tidiness.** The CLI moves under a running
   * daemon — `deploy/agents.sh` repoints `~/.local/bin/claude` or
   * `~/.reemoat/toolchain/bin/kimi` daily — so a memo held for the daemon's life
   * would pin the answer to whatever was installed at boot and quietly defeat this.
   * Ten minutes rather than the login probe's three seconds — see the constant for
   * why the two facts move at different speeds; and the updater calls
   * `forgetAvailability` besides, so the day's build is picked up at once. A
   * refresh `deploy.sh` makes without restarting the daemon is seen by nothing
   * here, so for up to ten minutes after one the *report* names the previous
   * build while the spawn already runs the new one — the file a held path names
   * was swapped by rename, and the path did not move.
   *
   * **Every caller that consumes the *path* is async and goes through here; the two
   * that are synchronous ask only whether a binary exists at all** — `loginSupport`
   * and `cannotAskHint` both compare `resolveLoginBinary(...) !== null`. That is
   * what keeps this from opening a window in which a login and a session could pick
   * differently: nothing synchronous ever picks.
   */
  async agentCli(agent: AgentId): Promise<AgentCliChoice | null> {
    const held = this.cliChosen.get(agent);
    if (held !== undefined && Date.now() - held.at < AGENT_CLI_TTL_MS) return held.value;
    const running = this.cliInFlight.get(agent);
    if (running !== undefined) return running;

    /*
     * `probeGeneration` is the fence, exactly as it is for `loginProbed`:
     * `forgetAvailability()` bumps it — a plugin change, a credential arriving, the
     * daily agent update — and a decision that started before the bump must not
     * write itself back afterwards, or the build the updater has just replaced is
     * held for another ten minutes.
     */
    const generation = this.probeGeneration;
    const run = this.chooseCli(agent)
      .then((value) => {
        /*
         * ⚠ **A miss is never held.** `findOnPath` forgets one after thirty seconds
         * for exactly this reason, and this cache sat over it with ten minutes — so
         * an install that `describe` could already see, `launch` could not, and the
         * adapter was spawned with the vendor's variable unset in precisely the
         * window `launch`'s comment says cannot open. A hit is a file, and stable;
         * a miss is what the next install disproves, and it costs nothing to ask
         * again, since a `null` here spawned no `--version`.
         */
        if (value !== null && generation === this.probeGeneration) this.cliChosen.set(agent, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.cliInFlight.get(agent) === run) this.cliInFlight.delete(agent);
      });
    this.cliInFlight.set(agent, run);
    return run;
  }

  /** {@link agentCli} without the cache. */
  private async chooseCli(agent: AgentId): Promise<AgentCliChoice | null> {
    const login = this.builtinLogin(agent);
    if (login === null) return null;

    const overrideName = login.executableEnv;
    if (overrideName !== null) {
      const override = (process.env[overrideName] ?? "").trim();
      if (override.length > 0) {
        return { path: override, version: await this.cliVersion(override), source: "override" };
      }
    }

    // `null` here is a harness with no CLI at all — `describe` has already refused
    // it with a sentence, and `GET /agents` draws it unavailable; this is the same
    // absence seen from the reporting side.
    const onPath = findOnPath(login.command);
    if (onPath === null) return null;
    return { path: onPath, version: await this.cliVersion(onPath), source: "path" };
  }

  /**
   * What `<cli> --version` says, reduced to the first dotted number in it.
   *
   * The CLIs disagree about the rest of the line — `2.1.259 (Claude Code)` against
   * `codex-cli 0.146.1` — so the number is taken wherever it sits rather than by
   * position. `null` for anything that does not answer one; the binary still runs,
   * and the line under the model list names the program without a number.
   */
  private async cliVersion(command: string): Promise<string | null> {
    const out = await this.exec(command, ["--version"], agentEnv(), "stdout");
    return firstVersion(out ?? "");
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
    // A contributed harness has no status probe at all, which is kimi's permanent
    // position: "cannot tell" is the correct answer and there is nothing to say
    // about it. `null` before the row is read, since there is no row.
    const login = this.builtinLogin(agent);
    if (login === null) return null;
    if (login.status === null) return null;
    if (this.resolveLoginBinary(agent) !== null) return null;
    const overrideName = login.executableEnv;
    // Named from the table rather than written out, because an agent that has no
    // such variable used to be told to set claude's.
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
    const pasted = Object.keys(this.secrets(agent)).length > 0;
    /*
     * ⚠ **A contributed harness lands on the same answer opencode does, and by the
     * same argument.** It has neither a status command nor a credential path, so
     * `false` is not a fact this daemon can produce honestly — and `admit` refuses
     * on `loggedIn === false`, so manufacturing one would put "not signed in" in
     * front of an agent that had just answered a prompt. A pasted key says a
     * provider was configured; everything else is "cannot tell".
     *
     * ⚠ **And this stayed `null` when the daemon learned to remember a refused
     * start, which is the whole reason that record is a separate field.** Writing
     * it here instead would have been read by `admit` — and `admit` guards
     * `AgentAskRuns.claim`, the one thing that ever spawns such a harness again.
     * The record would have blocked the only spawn that could have cleared it,
     * and a harness that refused once could never be found to have been fixed.
     */
    const spec = this.builtinLogin(agent);
    if (spec === null) return pasted ? true : null;

    if (spec.status !== null) {
      // ⚠ **The chosen build, or the probe answers about a binary nothing runs.**
      // "signed in" is a fact about one CLI's credential store, and the two builds
      // need not share one.
      const command = (await this.agentCli(agent))?.path ?? null;
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
