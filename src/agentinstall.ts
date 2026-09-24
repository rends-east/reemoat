import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { AgentId } from "./acp/agents.js";
import type { AgentScriptGate, ScriptHolder } from "./agentscript.js";
import { PACKAGE_ROOT, RUN_TIMEOUT_MS, updateEnv } from "./agentupdate.js";
import { readFrom } from "./transcript.js";

// Installs one harness on a press via deploy/agents.sh --only; one run daemon-wide, and a second start is refused.

/** How long a finished record stays readable. Measured from `endedAt`. */
export const INSTALL_RETAIN_MS = 10 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60_000;

const MAX_OUTPUT_BYTES = 64 * 1024;

const MAX_DETAIL_CHARS = 2000;

// installed and failed come from asking the machine, since a failed install exits 0; locked is the one outcome the status carries.
export type InstallOutcome =
  | "running"
  | "installed"
  | "failed"
  | "locked"
  | "timeout"
  | "cancelled"
  | "spawn_failed";

export type InstallPhase = "start" | "download" | "install" | "link" | "done" | "failed";

const PHASES: readonly InstallPhase[] = ["start", "download", "install", "link", "done", "failed"];

// Phases with a write outside $TMP in flight, where a Stop is refused: the phase line cannot say which half of install is the safe npm one.
const MID_WRITE_PHASES: readonly InstallPhase[] = ["install", "link"];

// Line framing is per stream: one shared carry splices a stderr warning into a stdout checkpoint.
export type InstallStream = "stdout" | "stderr";

// deploycheck drives this parser against the script's emitter. Unknown agents and phases answer null rather than ending a working run.
export function readStep(line: string): { agent: string; phase: InstallPhase } | null {
  const match = /^step: (\S+) (\S+)$/.exec(line.trim());
  if (match === null) return null;
  const [, agent, phase] = match;
  if (agent === undefined || phase === undefined) return null;
  if (!(PHASES as readonly string[]).includes(phase)) return null;
  return { agent, phase: phase as InstallPhase };
}

export interface InstallRunView {
  installId: string;
  agent: AgentId;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  outcome: InstallOutcome;
  exit: { code: number | null; signal: string | null } | null;
  phase: InstallPhase | null;
  detail: string | null;
  dropped: number;
  cursor: number;
  /** Whether a Stop would be honoured now, so a client can hide the button rather than meet the refusal. */
  cancellable: boolean;
}

export interface InstallChunk extends InstallRunView {
  chunk: string;
  gap: boolean;
}

export type InstallStart =
  | { kind: "ok"; view: InstallRunView }
  // ScriptHolder itself, never a copy of its fields: server.ts ships it as the busy detail.
  | { kind: "busy"; holder: ScriptHolder }
  | { kind: "spawn_failed"; detail: string };

class InstallRun {
  private buffer = "";
  private droppedBytes = 0;
  private readonly carries: Record<InstallStream, string> = { stdout: "", stderr: "" };
  private exitRecord: { code: number | null; signal: string | null } | null = null;
  private phase_: InstallPhase | null = null;
  private outcome_: InstallOutcome = "running";
  private endedAt_: number | null = null;
  private settling = false;

  readonly startedAt = Date.now();

  constructor(
    readonly installId: string,
    readonly agent: AgentId,
    private readonly kill: () => void,
  ) {}

  get done(): boolean {
    return this.endedAt_ !== null;
  }

  get outcome(): InstallOutcome {
    return this.outcome_;
  }

  get cancellable(): boolean {
    if (this.done) return false;
    return this.phase_ === null || !MID_WRITE_PHASES.includes(this.phase_);
  }

  view(): InstallRunView {
    return {
      installId: this.installId,
      agent: this.agent,
      startedAt: this.startedAt,
      endedAt: this.endedAt_,
      done: this.done,
      outcome: this.outcome_,
      exit: this.exitRecord,
      phase: this.phase_,
      detail: this.buffer.trim().slice(-MAX_DETAIL_CHARS) || null,
      dropped: this.droppedBytes,
      cursor: this.droppedBytes + this.buffer.length,
      cancellable: this.cancellable,
    };
  }

  read(since: number): InstallChunk {
    return { ...this.view(), ...readFrom(this.buffer, this.droppedBytes, since) };
  }

  append(text: string, stream: InstallStream = "stdout"): void {
    const whole = this.carries[stream] + text;
    const lastBreak = whole.lastIndexOf("\n");
    const complete = lastBreak === -1 ? "" : whole.slice(0, lastBreak + 1);
    this.carries[stream] = lastBreak === -1 ? whole : whole.slice(lastBreak + 1);
    if (complete.length === 0) return;
    for (const line of complete.split("\n")) {
      const step = readStep(line);
      if (step !== null && step.agent === this.agent) this.phase_ = step.phase;
    }
    this.buffer += complete;
    this.cap();
  }

  private cap(): void {
    if (this.buffer.length <= MAX_OUTPUT_BYTES) return;
    const cut = this.buffer.length - MAX_OUTPUT_BYTES;
    this.buffer = this.buffer.slice(cut);
    this.droppedBytes += cut;
  }

  private flushCarry(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.carries[stream].length === 0) continue;
      this.buffer += this.carries[stream];
      this.carries[stream] = "";
    }
    this.cap();
  }

  end(exit: { code: number | null; signal: string | null }, outcome: InstallOutcome): void {
    if (this.endedAt_ !== null) return;
    this.flushCarry();
    this.exitRecord = exit;
    this.outcome_ = outcome;
    this.endedAt_ = Date.now();
  }

  // Latched before the first await: a failed spawn emits both error and close, and a second settle would release the gate twice.
  beginSettle(): boolean {
    if (this.settling || this.endedAt_ !== null) return false;
    this.settling = true;
    return true;
  }

  cancel(): boolean {
    if (this.done || !this.cancellable) return false;
    this.kill();
    return true;
  }

  expired(now: number): boolean {
    return this.endedAt_ !== null && now - this.endedAt_ > INSTALL_RETAIN_MS;
  }
}

export interface AgentInstallOptions {
  gate: AgentScriptGate;
  /** Called only after onFinished's invalidation, or it reads a cached miss and reports a success as a failure. */
  verify: (agent: AgentId) => Promise<boolean>;
  onFinished: (agent: AgentId) => Promise<void> | void;
  onWarning: (detail: string) => void;
  source?: "vendor" | "npm";
  channel?: "stable" | "latest";
  spawnScript?: (agent: AgentId, args: readonly string[], run: InstallSink) => { kill: () => void };
}

export interface InstallSink {
  append: (text: string, stream?: InstallStream) => void;
  close: (exit: { code: number | null; signal: string | null }, outcome: InstallOutcome) => void;
}

export class AgentInstallRuns {
  private current: InstallRun | null = null;
  private readonly sweepTimer: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: AgentInstallOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  start(agent: AgentId): InstallStart {
    if (this.stopped) return { kind: "spawn_failed", detail: "this daemon is shutting down" };
    this.sweep();
    // A finished record is replaced; only a running one refuses.
    if (this.current !== null && !this.current.done) {
      return { kind: "busy", holder: { kind: "install", agent: this.current.agent, since: this.current.startedAt } };
    }
    if (!this.options.gate.tryHold("install", agent)) {
      const holder = this.options.gate.holder;
      return {
        kind: "busy",
        holder: holder ?? { kind: "update", agent: null, since: Date.now() },
      };
    }
    const installId = `in_${randomBytes(6).toString("hex")}`;
    const args = ["--only", agent, "--fail-if-locked"];
    if (this.options.source === "npm") args.push("--source", "npm");
    args.push("--channel", this.options.channel ?? "latest");

    let run: InstallRun | null = null;
    const sink: InstallSink = {
      append: (text, stream) => run?.append(text, stream),
      close: (exit, outcome) => {
        if (run === null) return;
        void this.settle(run, exit, outcome);
      },
    };
    let handle: { kill: () => void };
    try {
      handle = (this.options.spawnScript ?? spawnAgentsScript)(agent, args, sink);
    } catch (error) {
      this.options.gate.release("install");
      return { kind: "spawn_failed", detail: error instanceof Error ? error.message : String(error) };
    }
    run = new InstallRun(installId, agent, handle.kill);
    this.current = run;
    return { kind: "ok", view: run.view() };
  }

  // Invalidate, then ask: findOnPath caches misses. Done here rather than in the poll route, so a closed tab still refreshes the caches.
  private async settle(
    run: InstallRun,
    exit: { code: number | null; signal: string | null },
    outcome: InstallOutcome,
  ): Promise<void> {
    if (!run.beginSettle()) return;
    try {
      await this.options.onFinished(run.agent);
    } catch (error) {
      this.options.onWarning(
        `install ${run.installId} (${run.agent}): could not refresh what this machine knows: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let settled = outcome;
    if (outcome === "running") {
      let present = false;
      try {
        present = await this.options.verify(run.agent);
      } catch {
        present = false;
      }
      settled = present ? "installed" : "failed";
    }
    run.end(exit, settled);
    this.options.gate.release("install");
  }

  read(installId: string, since: number): InstallChunk | null {
    const run = this.current;
    if (run === null || run.installId !== installId) return null;
    return run.read(Math.max(0, since));
  }

  live(): InstallRunView | null {
    this.sweep();
    return this.current?.view() ?? null;
  }

  /** Refused from the mid-write checkpoint on (MID_WRITE_PHASES); the RUN_TIMEOUT_MS deadline still kills, since a hung run will not finish its write. */
  cancel(installId: string): boolean {
    const run = this.current;
    if (run === null || run.installId !== installId) return false;
    return run.cancel();
  }

  private sweep(now = Date.now()): void {
    if (this.current !== null && this.current.expired(now)) this.current = null;
  }

  /** Refuses new runs but never kills one in flight: a half-done install leaves a tree the next run must repair. */
  shutdown(): void {
    this.stopped = true;
    clearInterval(this.sweepTimer);
  }
}

// Streamed rather than buffered; the deadline kills the process group, or the installer under bash is orphaned.
function spawnAgentsScript(
  _agent: AgentId,
  args: readonly string[],
  sink: InstallSink,
): { kill: () => void } {
  const script = join(PACKAGE_ROOT, "deploy", "agents.sh");
  const child = spawn(script, [...args], {
    env: updateEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let timedOut = false;
  let stopped = false;
  // One sink.close per spawn: a failed spawn emits both error and close.
  let closed = false;
  const killGroup = (): void => {
    // Never signal a reaped child: its process group id may already belong to something else.
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone; `close` is on its way.
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, RUN_TIMEOUT_MS);
  deadline.unref();
  const finish = (
    exit: { code: number | null; signal: string | null },
    outcome: InstallOutcome,
  ): void => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    sink.close(exit, outcome);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => sink.append(chunk, "stdout"));
  child.stderr.on("data", (chunk: string) => sink.append(chunk, "stderr"));
  child.on("error", (error) => {
    sink.append(`${error.message}\n`, "stderr");
    finish({ code: null, signal: null }, "spawn_failed");
  });
  child.on("close", (code, signal) => {
    // 3 is the only status with a meaning (--fail-if-locked); anything else tells settle to ask the machine.
    const outcome: InstallOutcome = timedOut
      ? "timeout"
      : stopped
        ? "cancelled"
        : code === 3
          ? "locked"
          : "running";
    finish({ code, signal }, outcome);
  });
  return {
    kill: () => {
      stopped = true;
      clearTimeout(deadline);
      killGroup();
    },
  };
}
