import { randomBytes } from "node:crypto";

import type { AgentId } from "./acp/agents.js";
import type { LoginProcess, SessionRuntime } from "./runtime/types.js";
import { readFrom } from "./transcript.js";

// Drives an agent's own login flow in a pty over polled HTTP; the login table is fixed, so nothing on the wire names a program (Q6.111).

/** No getter on purpose: a secret's only destination is an agent's environment, through envFor. */
export interface AgentCredentialStore {
  list(): { agent: string; envName: string; updatedAt: number }[];
  envFor(agent: string): Record<string, string>;
  save(agent: string, envName: string, secret: string): void;
  remove(agent: string, envName: string): void;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CARRY_BYTES = 4 * 1024;
const LOGIN_TTL_MS = 10 * 60 * 1000;
// A timer rather than traffic: an abandoned login produces none.
const SWEEP_INTERVAL_MS = 60_000;

export interface LoginRunView {
  loginId: string;
  agent: AgentId;
  startedAt: number;
  done: boolean;
  exit: { code: number | null; signal: string | null } | null;
  dropped: number;
  cursor: number;
}

export type LoginWriteResult =
  | { kind: "ok"; view: LoginRunView }
  | { kind: "not_found" }
  | { kind: "not_interactive" };

export interface LoginChunk extends LoginRunView {
  chunk: string;
  gap: boolean;
}

export { readFrom };

class LoginRun {
  private buffer = "";
  private droppedBytes = 0;
  private carry = "";
  private exitRecord: { code: number | null; signal: string | null } | null = null;
  private disposed = false;

  readonly startedAt = Date.now();

  constructor(
    readonly loginId: string,
    readonly agent: AgentId,
    private readonly process_: LoginProcess,
  ) {
    process_.stdout.setEncoding("utf8");
    process_.stderr.setEncoding("utf8");
    process_.stdout.on("data", (chunk: string) => this.append(chunk));
    process_.stderr.on("data", (chunk: string) => this.append(chunk));
    process_.onceExit((code, signal) => {
      this.exitRecord = { code, signal: signal ?? null };
    });
  }

  get done(): boolean {
    return this.exitRecord !== null || this.process_.hasExited;
  }

  get cursor(): number {
    return this.droppedBytes + this.buffer.length;
  }

  view(): LoginRunView {
    return {
      loginId: this.loginId,
      agent: this.agent,
      startedAt: this.startedAt,
      done: this.done,
      exit: this.exitRecord,
      dropped: this.droppedBytes,
      cursor: this.cursor,
    };
  }

  read(since: number): LoginChunk {
    return { ...this.view(), ...readFrom(this.buffer, this.droppedBytes, since) };
  }

  get interactive(): boolean {
    return this.process_.stdin !== null;
  }

  /** false when the flow has no stdin (a BSD device-code login), so the route can say the code went nowhere. */
  write(text: string): boolean {
    if (this.process_.stdin === null) return false;
    if (this.done || this.disposed) return true;
    this.process_.stdin.write(`${text}\n`);
    return true;
  }

  expired(now: number): boolean {
    return now - this.startedAt > LOGIN_TTL_MS;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // EOF, then the process group, never the process alone: script is the parent of the CLI holding the pty.
    this.process_.endStdin();
    if (!(await this.process_.waitForExit(1_000))) {
      await this.process_.kill("SIGTERM");
      if (!(await this.process_.waitForExit(1_000))) await this.process_.kill("SIGKILL");
    }
  }

  private append(chunk: string): void {
    const { text, carry } = sanitize(this.carry + chunk);
    // The carry is bounded too: an unterminated OSC would otherwise be held back and grow for ever.
    const flushed = carry.length > MAX_CARRY_BYTES;
    this.carry = flushed ? "" : carry;

    this.buffer += text;
    if (flushed) this.buffer += scrub(carry);

    // Unconditional: an all-carry chunk has empty text and must still be bounded.
    if (this.buffer.length > MAX_OUTPUT_BYTES) {
      const excess = this.buffer.length - MAX_OUTPUT_BYTES;
      this.buffer = this.buffer.slice(excess);
      this.droppedBytes += excess;
    }
  }
}

export interface AgentLoginRunsOptions {
  runtime: SessionRuntime;
  onWarning?: (detail: string) => void;
}

/** One run per agent; a second start for the same agent supersedes, since a closed tab must not wall anybody out. */
export class AgentLoginRuns {
  private readonly byAgent = new Map<AgentId, LoginRun>();
  // Serialises starts per agent: two concurrent starts would both spawn and orphan the loser.
  private readonly starting = new Map<string, Promise<LoginRunView | null>>();
  // Re-checked after doStart's awaits, so a start racing shutdown cannot outlive it.
  private stopped = false;
  private readonly runtime: SessionRuntime;
  private readonly onWarning: (detail: string) => void;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(options: AgentLoginRunsOptions) {
    this.runtime = options.runtime;
    this.onWarning = options.onWarning ?? (() => {});
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async start(agent: AgentId): Promise<LoginRunView | null> {
    if (this.stopped) return null;
    const key = agent;
    const previous = this.starting.get(key);
    const attempt = (previous ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.doStart(agent));
    this.starting.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (this.starting.get(key) === attempt) this.starting.delete(key);
    }
  }

  private async doStart(agent: AgentId): Promise<LoginRunView | null> {
    this.sweep();
    await this.cancelRun(this.byAgent.get(agent));

    const process_ = await this.runtime.login(agent);
    if (process_ === null) return null;

    const run = new LoginRun(`li_${randomBytes(8).toString("hex")}`, agent, process_);
    if (this.stopped) {
      await this.cancelRun(run);
      return null;
    }
    this.byAgent.set(agent, run);
    return run.view();
  }

  read(loginId: string, since: number): LoginChunk | null {
    const run = this.own(loginId);
    return run === null ? null : run.read(since);
  }

  write(loginId: string, text: string): LoginWriteResult {
    const run = this.own(loginId);
    if (run === null) return { kind: "not_found" };
    if (!run.write(text)) return { kind: "not_interactive" };
    return { kind: "ok", view: run.view() };
  }

  async cancel(loginId: string): Promise<boolean> {
    const run = this.own(loginId);
    if (run === null) return false;
    this.byAgent.delete(run.agent);
    await this.cancelRun(run);
    return true;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.starting.values()]);
    const runs = [...this.byAgent.values()];
    this.byAgent.clear();
    await Promise.all(runs.map((run) => this.cancelRun(run)));
  }

  // Matched against the live run, so a superseded wizard cannot type into its successor's stdin.
  private own(loginId: string): LoginRun | null {
    this.sweep();
    for (const run of this.byAgent.values()) {
      if (run.loginId === loginId) return run;
    }
    return null;
  }

  private async cancelRun(run: LoginRun | undefined): Promise<void> {
    if (run === undefined) return;
    await run.dispose().catch((error: unknown) => {
      this.onWarning(`could not stop login ${run.loginId}: ${String(error)}`);
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, run] of this.byAgent) {
      if (!run.expired(now)) continue;
      this.byAgent.delete(key);
      void this.cancelRun(run);
      this.onWarning(
        `login ${run.loginId} (${run.agent}) expired after ${LOGIN_TTL_MS / 60_000} minutes`,
      );
    }
  }
}

const ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const PARTIAL_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?)?$/;

/** Strips escape sequences for a pre; a lone CR becomes a newline, and a trailing sequence that may be split comes back as carry. */
export function sanitize(input: string): { text: string; carry: string } {
  const partial = PARTIAL_ESCAPE.exec(input);
  const carry = partial !== null && partial[0].length > 0 ? partial[0] : "";
  const body = carry.length > 0 ? input.slice(0, input.length - carry.length) : input;
  return { text: scrub(body), carry };
}

function scrub(body: string): string {
  return (
    body
      .replace(ESCAPE, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[^\n]\x08/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}
