import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentEnv, type AgentId } from "./acp/agents.js";

// Refreshes the agent CLIs this daemon spawns through deploy/agents.sh, since none self-updates under ACP (Q7.42, Q4.115).
export interface RunOutcome {
  ok: boolean;
  detail: string | null;
  warnings?: string | null;
}

export interface AgentUpdateOptions {
  gate?: { tryHold: (kind: "update") => boolean; release: (kind: "update") => void };
  busy: () => readonly AgentId[];
  /** Nothing in `src/` prints; a failed run, and every vendor a run could not reach, is reported here. */
  onWarning: (detail: string) => void;
  onUpdated: (report: string | null) => void;
  mode?: "daily" | "off";
  source?: "vendor" | "npm";
  /** Passed even at its default, so the env file rather than the script's default decides (Q4.115). */
  channel?: "stable" | "latest";
  run?: (script: string, args: readonly string[]) => Promise<RunOutcome>;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  jitter?: () => number;
}

export const FIRST_RUN_DELAY_MS = 5 * 60_000;

export const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

export const UPDATE_JITTER = 0.1;

const MAX_DETAIL_CHARS = 2000;

export const RUN_TIMEOUT_MS = 20 * 60_000;

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class AgentUpdates {
  private timer: { cancel: () => void } | null = null;
  private stopped: Promise<void> | null = null;
  private running = false;
  private ran = false;

  private constructor(private readonly options: AgentUpdateOptions) {}

  static start(options: AgentUpdateOptions): AgentUpdates {
    const runs = new AgentUpdates(options);
    if ((options.mode ?? "daily") !== "off") runs.arm(FIRST_RUN_DELAY_MS);
    return runs;
  }

  shutdown(): Promise<void> {
    return (this.stopped ??= this.doShutdown());
  }

  /** Runs the armed first run now. A no-op once any run has happened, or the resume pass that nudges would loop. */
  nudge(): void {
    if (this.stopped !== null || this.running || this.ran || this.timer === null) return;
    this.timer.cancel();
    this.timer = null;
    void this.tick();
  }

  private async doShutdown(): Promise<void> {
    this.timer?.cancel();
    this.timer = null;
    // Neither awaited nor killed: a kill half-writes a CLI, and the script ignores SIGPIPE so it survives this process exiting.
  }

  private arm(delayMs: number): void {
    if (this.stopped !== null) return;
    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref();
        return { cancel: () => clearTimeout(handle) };
      });
    this.timer = schedule(() => void this.tick(), delayMs);
  }

  private nextDelay(): number {
    const jitter = this.options.jitter ?? Math.random;
    return Math.round(UPDATE_INTERVAL_MS * (1 + (jitter() * 2 - 1) * UPDATE_JITTER));
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped !== null) return;
    // Skipped, not queued: two installers writing the same directories is the one corruption to prevent.
    // The gate is taken before runOnce, which sets ran: a refused run must not spend the one nudge.
    const gate = this.options.gate;
    const held = gate === undefined || gate.tryHold("update");
    if (!held) {
      // Re-armed short, or a run skipped for an install would cost a day's refresh.
      this.arm(FIRST_RUN_DELAY_MS);
      return;
    }
    if (!this.running) {
      this.running = true;
      try {
        await this.runOnce();
      } finally {
        this.running = false;
        gate?.release("update");
      }
    } else {
      gate?.release("update");
    }
    this.arm(this.nextDelay());
  }

  private async runOnce(): Promise<void> {
    this.ran = true;
    const script = join(PACKAGE_ROOT, "deploy", "agents.sh");
    const args: string[] = [];
    if (this.options.source === "npm") args.push("--source", "npm");
    args.push("--channel", this.options.channel ?? "latest");
    // Always refresh-only: nothing but a person's press puts a harness on a machine.
    args.push("--refresh-only");
    for (const agent of this.options.busy()) args.push("--skip", agent);
    const run = this.options.run ?? runScript;
    let answer: RunOutcome;
    try {
      answer = await run(script, args);
    } catch (error) {
      answer = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!answer.ok) {
      this.options.onWarning(`agent update failed: ${answer.detail ?? "no output"}`);
      return;
    }
    const warnings = (answer.warnings ?? "").trim();
    if (warnings.length > 0) this.options.onWarning(`agent update: ${warnings}`);
    this.options.onUpdated(answer.detail);
  }
}

export function agentSourceFrom(value: string | undefined, warn: (detail: string) => void): "vendor" | "npm" {
  const spelled = (value ?? "").trim().toLowerCase();
  if (spelled === "npm") return "npm";
  if (spelled !== "" && spelled !== "vendor") {
    warn(`REEMOAT_AGENT_SOURCE=${spelled} is not a source this daemon knows (vendor or npm); using vendor`);
  }
  return "vendor";
}

export function agentChannelFrom(value: string | undefined, warn: (detail: string) => void): "stable" | "latest" {
  const spelled = (value ?? "").trim().toLowerCase();
  if (spelled === "stable") return "stable";
  if (spelled !== "" && spelled !== "latest") {
    warn(`REEMOAT_AGENT_CHANNEL=${spelled} is not a channel this daemon knows (stable or latest); using latest`);
  }
  return "latest";
}

/** agentEnv with HOME set outright: keeps REEMOAT_TOKEN from vendor installers, and HOME must match MANAGED_CLI_DIRS. */
export function updateEnv(): NodeJS.ProcessEnv {
  return { ...agentEnv(), HOME: homedir() };
}

const MAX_STREAM_CHARS = 64 * 1024;

function keepTail(held: string, chunk: Buffer): string {
  const next = held + chunk.toString();
  return next.length > MAX_STREAM_CHARS ? next.slice(-MAX_STREAM_CHARS / 2) : next;
}

/** Spawned detached so the deadline kills the whole process group, installers included. */
export function runScript(script: string, args: readonly string[], timeoutMs = RUN_TIMEOUT_MS): Promise<RunOutcome> {
  return new Promise((resolve_) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(script, [...args], { env: updateEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const deadline = setTimeout(() => {
      timedOut = true;
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
