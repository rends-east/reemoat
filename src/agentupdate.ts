import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentEnv, type AgentId } from "./acp/agents.js";

/**
 * Keeping the coding-agent CLIs current, because none of them does it itself.
 *
 * ⚠ **This is not the daemon updating itself, and the distinction is the whole
 * argument.** `src/version.ts` states that a daemon does not update itself and is
 * never told to, and fleet rollout is a stated non-goal (Q7.42). Both still hold:
 * what moves here is a set of *third-party programs the daemon spawns*, out of tree,
 * started fresh at every session start and fetched by `deploy/agents.sh` on the
 * schedule below. Nothing in this repository is replaced, no
 * `pnpm install` runs, and — the part that separates it from every reason those
 * positions exist — **no daemon restart is needed**, so no turn in flight is
 * interrupted and no pending approval is dropped.
 *
 * **Why it has to exist at all.** Measured 2026-09-03: not one of the four CLIs
 * self-updates under ACP. Their updaters are gated on a terminal a daemon-spawned
 * agent never has — claude's is an Ink component mounted only by TUI screens, codex
 * only prints a nag, opencode's upgrade check is reached from its TUI command
 * handler and never from `acp`, kimi's preflight runs only from its main command.
 * The drift is the proof: on the machine this was written on, kimi sat at 0.29.2
 * against 0.40.1 upstream and codex at 0.146.1 against 0.153.0 — both months behind,
 * both never run in a terminal there — while claude, which *is* run in a terminal
 * there, was current. A model released last week is simply absent, with no error.
 *
 * **The work is a shell script, not code here**, and that is deliberate: every
 * vendor hostname lives in `deploy/agents.sh`, so `src/` gains no fourth `fetch` —
 * `plugins.md` names the three it holds, and that count is the property.
 */
/** What one run of the script came to. */
export interface RunOutcome {
  /** Whether the script ran to its end: `false` for a spawn failure, the deadline, or a non-zero exit. */
  ok: boolean;
  /** The tail of what it printed on either stream, to explain a `false`. */
  detail: string | null;
  /**
   * What it printed on stderr, on its own. Every vendor it could not reach is a
   * line there and the exit status says nothing about them on purpose, so this is
   * the only way a failed refresh reaches an operator.
   */
  warnings?: string | null;
}

export interface AgentUpdateOptions {
  /**
   * Which harnesses have a live agent right now.
   *
   * ⚠ **Read at the moment of the run rather than captured**, because the answer is
   * whatever is happening when the timer fires. What the script does with each name
   * is its own decision — what a name withholds is the pruning of the previous
   * versioned build of any harness that arrived through npm, which is kimi always
   * and all four under `--source npm`, while the three native installers swap by
   * rename and have nothing to withhold (Q4.114) — but the daemon has no business
   * knowing which, so it reports them all.
   */
  busy: () => readonly AgentId[];
  /** Nothing in `src/` prints; a failed run, and every vendor a run could not reach, is reported here. */
  onWarning: (detail: string) => void;
  /**
   * Called after every run that completed, whether or not it changed anything,
   * with the tail of what the script printed.
   *
   * The script cannot say which: it exits 0 whatever each vendor answered, and a
   * refresh that found nothing newer is indistinguishable from one that swapped a
   * binary. So the caller drops its cached CLI choice either way — a `--version`
   * per harness once a day is the whole cost, and the alternative is the daemon
   * going on launching the build it resolved before, for the length of
   * `LocalRuntime.agentCli`'s cache, while a fresh CLI sits unused on disk.
   *
   * The report is what the script said on either stream, bounded, so the caller
   * can put a run that changed nothing in the log as well: a daily run of three
   * vendors' installers that leaves no line behind was measured as invisible —
   * somebody waited seven minutes for one and then went to the filesystem.
   */
  onUpdated: (report: string | null) => void;
  /** `daily`, or `off` to run nothing at all. Injected rather than read here. */
  mode?: "daily" | "off";
  /**
   * Where the script gets the CLIs from: each vendor's own installer, or the npm
   * registry for a machine that cannot reach those hosts (Q4.114).
   *
   * ⚠ **Passed as a flag on every run rather than left in the environment**,
   * because the script runs under `updateEnv()` — which strips everything
   * `REEMOAT_*`, this setting included — and because the bootstrap passes the same
   * flag for the install it does before the daemon exists, as `deploy.sh` does for
   * the run it makes before every restart, off the same env file. One value, three
   * callers, and none can quietly see a different one.
   */
  source?: "vendor" | "npm";
  /** Injected so a driver can run this offline, with no network and no clock. */
  run?: (script: string, args: readonly string[]) => Promise<RunOutcome>;
  /** Injected for the same reason. Must answer something `unref`-able or a fake. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  /** Injected so a driver can make the jitter deterministic. 0..1. */
  jitter?: () => number;
}

/**
 * How long after start the first run happens.
 *
 * ⚠ **Not at boot, and five minutes rather than one.** `restore()` and `autoResume`
 * are already starting an agent per interrupted session at that moment, and a
 * download of the order of 700 MB — four CLIs, on a machine that has none — racing
 * them would make the slowest part of a restart slower still.
 * It is also the window in which somebody who has just installed reemoat is watching:
 * a machine that spends its first minute pulling four CLIs looks stuck.
 */
export const FIRST_RUN_DELAY_MS = 5 * 60_000;

/** How often afterwards, before jitter. */
export const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How much the interval is spread, either way.
 *
 * A fleet installed by one `curl | sh` would otherwise ask three vendors for four
 * binaries at the same second every day — full jitter is the shape `autoResume`
 * already uses, and the reason is the same one.
 */
export const UPDATE_JITTER = 0.1;

/** How much of the script's output is kept to explain a failure. */
const MAX_DETAIL_CHARS = 2000;

/** How long one run may take before it is abandoned. */
const RUN_TIMEOUT_MS = 20 * 60_000;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class AgentUpdates {
  private timer: { cancel: () => void } | null = null;
  private stopped: Promise<void> | null = null;
  private running = false;
  /** Whether any run has started — see {@link nudge} for what that ends. */
  private ran = false;

  private constructor(private readonly options: AgentUpdateOptions) {}

  /**
   * Arms the schedule and returns the handle that disarms it.
   *
   * A static factory over a constructor that starts a timer, which is this
   * repository's shape for anything stateful — and here it also keeps `off` from
   * being a class that exists and does nothing: it arms no timer at all.
   */
  static start(options: AgentUpdateOptions): AgentUpdates {
    const runs = new AgentUpdates(options);
    if ((options.mode ?? "daily") !== "off") runs.arm(FIRST_RUN_DELAY_MS);
    return runs;
  }

  /** Idempotent, like every other shutdown here. */
  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  /**
   * Run now rather than at the armed time, if a run is armed at all.
   *
   * ⚠ **The five-minute first run is right until it is the thing a session is
   * waiting for.** `FIRST_RUN_DELAY_MS` keeps a download of the order of 700 MB
   * from racing the boot pass that puts an agent back on every interrupted
   * session — and on the first boot after the vendored CLIs went (Q4.114), on a
   * machine whose deploy path did not run the installer first, that pass had
   * nothing to race: three sessions met `opencode not found` and the binary
   * arrived five minutes later. So the pass reports the missing harness, the
   * daemon calls this, and the run that was going to happen anyway happens now.
   *
   * A no-op when nothing is armed: the updater is off, or already running (its
   * completion is what the caller wants and it is coming), or shut down. Never
   * a second run beside one in flight — that is the corruption `tick`'s guard
   * exists to prevent.
   *
   * ⚠ **And a no-op once any run has happened, which is what keeps this from
   * being a loop.** The daemon starts a resume pass after every completed run,
   * and that pass nudges again when a harness is still missing — so on a machine
   * where the CLI never arrives (vendor hosts blocked, no npm, an installer that
   * keeps failing; the script exits 0 for all of them) a nudge that merely pulled
   * the *next* run forward ran three vendors' installers back-to-back for the
   * daemon's life, with a log line and a cache flush per iteration. Found by six
   * reviewers independently before it shipped. What a nudge is for is the
   * five-minute delay on the *first* run; after that the day's timer is the
   * retry, and the sentence the resume pass logs is the operator's cue.
   */
  nudge(): void {
    if (this.stopped !== null || this.running || this.ran || this.timer === null) return;
    this.timer.cancel();
    this.timer = null;
    void this.tick();
  }

  private async doShutdown(): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    /*
     * A run in flight is *not* awaited and *not* killed. It is a detached shell
     * script that writes outside this repository; killing it mid-install is how a
     * half-written CLI happens, and awaiting it would spend up to twenty minutes of
     * a twenty-second shutdown budget. What it can no longer do is schedule another
     * one — `arm` checks `stopped`.
     *
     * ⚠ **"Not killed" took a measurement to make true.** The script runs on pipes
     * this daemon holds, and `shutdown` ends in `process.exit`, which closes them;
     * the script's next `printf` then got SIGPIPE — libuv resets dispositions in a
     * child — and the run died at its next line of output, EXIT trap and all, with
     * every harness after the current one skipped. The script now ignores SIGPIPE
     * and its output helpers tolerate a closed stream (see `deploy/agents.sh`), so
     * what is lost after this process is gone is the report, and only that. The
     * lock the script holds is what keeps the next daemon's own first run from
     * starting beside the orphan.
     */
  }

  private arm(delayMs: number): void {
    if (this.stopped !== null) return;
    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Or a daemon with nothing else to do would be held open by this alone.
        handle.unref();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = schedule(() => void this.tick(), delayMs);
  }

  private nextDelay(): number {
    const jitter = this.options.jitter ?? Math.random;
    // Both directions, so a fleet spreads either side of the interval rather than
    // drifting later every day.
    return Math.round(UPDATE_INTERVAL_MS * (1 + (jitter() * 2 - 1) * UPDATE_JITTER));
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped !== null) return;
    /*
     * A run that is still going when a tick fires is skipped rather than queued:
     * two installers writing the same directories is the one way this can corrupt
     * something. Through this class's own schedule the state is unreachable — the
     * next timer is armed only after `runOnce` settles — so what the guard is for
     * is an injected `schedule` that fires a callback twice, where the second
     * would otherwise start a second installer under the first.
     */
    if (!this.running) {
      this.running = true;
      try {
        await this.runOnce();
      } finally {
        this.running = false;
      }
    }
    this.arm(this.nextDelay());
  }

  private async runOnce(): Promise<void> {
    this.ran = true;
    const script = join(PACKAGE_ROOT, "deploy", "agents.sh");
    const args: string[] = [];
    if (this.options.source === "npm") args.push("--source", "npm");
    for (const agent of this.options.busy()) args.push("--skip", agent);
    const run = this.options.run ?? runScript;
    let answer: RunOutcome;
    try {
      answer = await run(script, args);
    } catch (error) {
      // Reported rather than thrown: this is a timer, and a throw here would reach
      // an unhandledRejection handler instead of the operator.
      answer = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!answer.ok) {
      this.options.onWarning(`agent update failed: ${answer.detail ?? "no output"}`);
      return;
    }
    /*
     * ⚠ **A run that completed is not a run that succeeded, and the script cannot
     * say which.** It exits 0 whatever each vendor answered — the installer must not
     * abort over a vendor being down — so the only record of `claude update failed`
     * is a line on stderr. Forwarded, or a fleet with every vendor blocked would read
     * as updated daily and warn nothing, which is the silent-success mode the script's
     * own kimi paragraph calls worse than not trying. The cache is still dropped:
     * three of four refreshing is three binaries that may have moved.
     */
    const warnings = (answer.warnings ?? "").trim();
    if (warnings.length > 0) this.options.onWarning(`agent update: ${warnings}`);
    this.options.onUpdated(answer.detail);
  }
}

/**
 * Where the script gets the CLIs from, read off `REEMOAT_AGENT_SOURCE`.
 *
 * `npm` is the one other answer, for a machine that cannot reach the vendors'
 * hosts (Q4.114). An unknown spelling is *reported* through `warn` and then read as
 * the default, rather than obeyed or refused: a typo here must not leave a machine
 * with no agents at all, and must not pass in silence either — the posture the
 * daemon's `REEMOAT_AGENT_UPDATES` switch takes, where every spelling of "no" is
 * accepted and nothing else is. Pure and exported so `daemoncheck` can hold the
 * spellings; `scripts/daemon.ts` passes `console.error`.
 */
export function agentSourceFrom(value: string | undefined, warn: (detail: string) => void): "vendor" | "npm" {
  const spelled = (value ?? "").trim().toLowerCase();
  if (spelled === "npm") return "npm";
  if (spelled !== "" && spelled !== "vendor") {
    warn(`REEMOAT_AGENT_SOURCE=${spelled} is not a source this daemon knows (vendor or npm); using vendor`);
  }
  return "vendor";
}

/**
 * The environment the script runs under, and it is not this daemon's.
 *
 * ⚠ **Three vendors' installers run under it, as this uid, daily.** `agentEnv()` is
 * what every other child of this daemon gets — the session-scoped `CLAUDE_*` names
 * and everything `REEMOAT_*` stripped — and this was the one spawn that did not use
 * it, so `REEMOAT_TOKEN` reached `curl … | bash` from three hosts this repository
 * neither vendors nor verifies. Hygiene rather than a fence, as `CLAUDE.md` says of
 * the strip; what it prevents is the token landing in somebody else's log.
 *
 * `HOME` is set outright to `homedir()`, because that is what `MANAGED_CLI_DIRS` is
 * built from and the script installs under `$HOME`: the two must name one directory,
 * and a service manager that launched this daemon with no `HOME` at all would
 * otherwise stop the script at its first line.
 */
export function updateEnv(): NodeJS.ProcessEnv {
  return { ...agentEnv(), HOME: homedir() };
}

/** How much of each stream is held while a run is in flight. */
const MAX_STREAM_CHARS = 64 * 1024;

function keepTail(held: string, chunk: Buffer): string {
  const next = held + chunk.toString();
  return next.length > MAX_STREAM_CHARS ? next.slice(-MAX_STREAM_CHARS / 2) : next;
}

/**
 * The default runner: the script, in a process group of its own, with its output
 * captured rather than printed.
 *
 * `spawn` and not a shell, so nothing here interpolates into a command line.
 *
 * ⚠ **Detached, because the deadline has to reach the grandchildren.** The script's
 * work is `bash` on a downloaded installer and `npm i -g` under it; `execFile`'s own
 * `timeout` signals the direct `sh` alone, so a stalled run left the installers
 * writing, `tick`'s `running` guard cleared, and the next day's run starting a second
 * installer over the same directories — the one corruption that guard exists to
 * prevent. Killing the group is what makes the deadline mean the whole run.
 *
 * `timeoutMs` is a parameter so a driver can reach the deadline in milliseconds.
 */
export function runScript(script: string, args: readonly string[], timeoutMs = RUN_TIMEOUT_MS): Promise<RunOutcome> {
  return new Promise((resolve_) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(script, [...args], { env: updateEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const deadline = setTimeout(() => {
      timedOut = true;
      // The group, not the child: a negative pid is what reaches the installers.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone; `close` is on its way.
      }
    }, timeoutMs);
    deadline.unref();
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve_(outcome);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk);
    });
    child.on("error", (error) => finish({ ok: false, detail: error.message, warnings: null }));
    child.on("close", (code, signal) => {
      const text = `${stdout}${stderr}`.trim().slice(-MAX_DETAIL_CHARS);
      const detail = timedOut
        ? `timed out after ${Math.round(timeoutMs / 60_000)} min${text.length > 0 ? `; ${text}` : ""}`
        : text;
      const warned = stderr.trim().slice(-MAX_DETAIL_CHARS);
      finish({
        ok: !timedOut && code === 0 && signal === null,
        detail: detail.length > 0 ? detail : null,
        warnings: warned.length > 0 ? warned : null,
      });
    });
  });
}
