import { randomBytes } from "node:crypto";

import type { AgentId } from "./acp/agents.js";
import type { LoginProcess, SessionRuntime } from "./runtime/types.js";

/**
 * Driving an agent's own login flow from a browser.
 *
 * Every agent authenticates out of band and reads its credentials from disk, and
 * the daemon can only inherit what is there — it never calls ACP's
 * `session/authenticate`. So something has to put credentials on that disk.
 *
 * This exists because **the person doing that is holding a phone.** On a machine
 * you are sitting at, `claude auth login` in a terminal is the whole answer and
 * always was; the point of this daemon is the case where you are not sitting at
 * it. The login flows are interactive terminal programs, so the daemon allocates
 * a pty (see `hostLoginArgs`) and relays the transcript.
 *
 * Two things are deliberately *not* here.
 *
 * **No WebSocket.** The daemon's stream is read-only, on the reasoning that
 * `ws.send()` into a half-open socket succeeds silently — so a client would
 * believe it had sent something that evaporated. A login code is exactly that
 * kind of message: sent once, unrecoverable if lost, and impossible to notice
 * missing from the other side. So input is an HTTP request whose response
 * confirms it landed, and output is polled.
 *
 * **No arbitrary command.** The runtime's login table is fixed. Nothing on the
 * wire names a program, so "a caller cannot run code of their choosing as the
 * daemon" holds because there is nothing to pass, not because a validator
 * catches it. That was a tenant fence and it is still worth having: this daemon
 * is reachable from the internet through the relay.
 */

/**
 * Where pasted credentials live, as the server needs them.
 *
 * An interface rather than the SQLite class so `src/` keeps pointing one way and
 * the offline drivers can supply a map. `SqliteAgentCredentialStore` satisfies
 * it structurally.
 *
 * Note what is missing: there is no `get(agent) -> string`. The only
 * correct destination for one of these is an agent process, and `envFor` is
 * shaped for exactly that. A getter is how a secret ends up in a response body.
 */
export interface AgentCredentialStore {
  list(): { agent: string; envName: string; updatedAt: number }[];
  envFor(agent: string): Record<string, string>;
  save(agent: string, envName: string, secret: string): void;
  remove(agent: string, envName: string): void;
}

/** 64 KiB of transcript is far more than a device-code flow produces. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * Ceiling on a held-back partial escape sequence. See `LoginRun.append`.
 *
 * Generous by two orders of magnitude: the longest thing this legitimately holds
 * is an OSC 8 hyperlink carrying an authorize URL, which is a few hundred bytes.
 */
const MAX_CARRY_BYTES = 4 * 1024;
/**
 * How long an abandoned login may hold a pty.
 *
 * A person who closes the tab mid-flow leaves a process waiting on stdin
 * forever. Ten minutes is comfortably longer than any of these flows takes and
 * short enough that a forgotten one is gone before it matters.
 */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/**
 * How often the TTL above is actually checked.
 *
 * A timer and not only the request paths, which is the whole point rather than
 * belt-and-braces. `sweep()` used to run exclusively from `start`, `read` and
 * `write` — so it fired on *activity*, and the case the TTL exists for produces
 * none: a person who closes the tab stops polling, nothing calls in, and the
 * abandoned login held a pty until the daemon exited or they happened to start
 * another one. The one state the expiry was written to clean up was the one state
 * it could never observe.
 *
 * A minute is far below the TTL, so an expired run is gone within ~10% of its
 * lifetime, and cheap: the map holds at most one entry per agent and the sweep is
 * a comparison per entry.
 */
const SWEEP_INTERVAL_MS = 60_000;

export interface LoginRunView {
  loginId: string;
  agent: AgentId;
  startedAt: number;
  done: boolean;
  exit: { code: number | null; signal: string | null } | null;
  /** Bytes of output discarded off the front of the buffer, if it ever filled. */
  dropped: number;
  /** Total output produced so far. A client's cursor is an offset into this. */
  cursor: number;
}

export type LoginWriteResult =
  | { kind: "ok"; view: LoginRunView }
  | { kind: "not_found" }
  | { kind: "not_interactive" };

export interface LoginChunk extends LoginRunView {
  /** Output since the requested cursor. Empty when there is nothing new. */
  chunk: string;
  /** True when the requested cursor pointed at output that has been discarded. */
  gap: boolean;
}

/**
 * Where a client's cursor lands in a transcript that may have lost its front.
 *
 * Pure and exported so `webcheck` can assert *this* rather than a transcription
 * of it. It was asserting a copy: the driver defined its own `read` closure with
 * the same three lines and checked that, under a comment about a login transcript
 * being "exactly where a lost line is the one with the code in it". The two were
 * identical, which is precisely what made the drift undetectable — the section
 * would have stayed green with this function deleted.
 *
 * `since` below `dropped` is a gap, not an error: the caller asked for output
 * that has been discarded, and the honest answer is the oldest that survives plus
 * a flag saying something is missing.
 */
export function readFrom(
  buffer: string,
  dropped: number,
  since: number,
): { chunk: string; gap: boolean } {
  const from = Math.max(since, dropped);
  return { chunk: buffer.slice(from - dropped), gap: since < dropped };
}

class LoginRun {
  private buffer = "";
  /** How much has been discarded off the front. `dropped + buffer.length` is the cursor. */
  private droppedBytes = 0;
  /** A trailing partial escape sequence, held back so it is not printed as text. */
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
    // Both pipes into one transcript, in arrival order. These flows print
    // prompts to one and progress to the other with no consistency worth
    // modelling, and a person reading the pane wants what the terminal would
    // have shown them.
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

  /** Whether this flow reads input at all. See `loginStdio`. */
  get interactive(): boolean {
    return this.process_.stdin !== null;
  }

  /**
   * Writes one line to the flow's stdin. The newline is ours, not the caller's.
   *
   * Answers whether the write was *possible*, not whether it landed — the caller
   * needs the first to tell somebody their code went nowhere, and nothing here
   * can know the second. `false` for a flow spawned with no stdin, which is a
   * device-code login on BSD and never a mistake; the route turns it into a `400`
   * rather than the silent no-op an unguarded `stdin?.write` would be.
   */
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
    // Same ladder as a session: EOF first, because a flow waiting on stdin ends
    // cleanly on it, then the process group. Never the process alone — `script`
    // is the parent of the CLI that is actually holding the pty.
    this.process_.endStdin();
    if (!(await this.process_.waitForExit(1_000))) {
      await this.process_.kill("SIGTERM");
      if (!(await this.process_.waitForExit(1_000))) await this.process_.kill("SIGKILL");
    }
  }

  private append(chunk: string): void {
    const { text, carry } = sanitize(this.carry + chunk);
    /*
     * The carry is bounded too, and it was the one thing here that was not.
     *
     * `PARTIAL_ESCAPE`'s OSC branch matches an *unterminated* `\x1b]` of any
     * length, so output that opens one and never closes it is held back entirely:
     * the carry grows with every chunk, is rescanned from the front each time, and
     * the transcript stops advancing. `MAX_OUTPUT_BYTES` is documented as the
     * bound on a login run and this was the path around it. A real escape sequence
     * is tens of bytes, so anything past this ceiling is not one — flushing it as
     * text is both the honest reading and the terminating one.
     */
    const flushed = carry.length > MAX_CARRY_BYTES;
    this.carry = flushed ? "" : carry;

    // Text first, then the flushed carry. The carry is the *tail* of what
    // `sanitize` was handed, so appending it ahead of the body wrote those bytes
    // into the transcript in the wrong order.
    this.buffer += text;
    // Scrubbed like every other byte that reaches this buffer. It is here
    // precisely because it is **not** an escape sequence, so it is ordinary
    // output — and going in raw put ESC and the C0 range `scrub` exists to remove
    // straight into a string the client renders in a `<pre>`.
    if (flushed) this.buffer += scrub(carry);

    /*
     * Unconditional, and that is the fix rather than a tidy-up.
     *
     * This trim used to sit below `if (text.length === 0) return;`, which is the
     * exact shape of the chunk that reaches the flush above: an unterminated
     * `\x1b]` matches `PARTIAL_ESCAPE` whole, so `text` is empty and `carry` is
     * the entire write. Every such chunk added its bytes to the buffer and
     * returned before the only statement that bounds it — so a CLI emitting one
     * per write grew this transcript without any ceiling at all, for the run's
     * whole 10-minute TTL, while `MAX_OUTPUT_BYTES` went on being documented as
     * the bound on a login run. The polling wizard reads all of it.
     */
    if (this.buffer.length > MAX_OUTPUT_BYTES) {
      const excess = this.buffer.length - MAX_OUTPUT_BYTES;
      this.buffer = this.buffer.slice(excess);
      this.droppedBytes += excess;
    }
  }
}

export interface AgentLoginRunsOptions {
  runtime: SessionRuntime;
  /** Nothing in `src/` prints; this is how an operator hears about a stuck login. */
  onWarning?: (detail: string) => void;
}

/**
 * Every login flow currently in progress, one per agent.
 *
 * A second run for the *same* agent **supersedes** the first rather than being
 * refused. Refusing is the obvious choice and the wrong one: the commonest way a
 * flow ends is somebody closing the tab, which leaves a process waiting on stdin
 * with nobody to type into it — and "you already have a login in progress" would
 * then be a permanent wall in front of the one person who cannot get past it any
 * other way.
 *
 * **Per agent, and collapsing this to a single slot would reintroduce a measured
 * defect.** The Settings screen renders one independent wizard per agent, each
 * backed by its own `sessionStorage` entry, so more than one can be open at once,
 * which is the normal state for somebody logging in to claude *and* kimi. With
 * one slot, starting the second superseded the first; the superseded wizard's
 * next 700ms poll answered 404 and it started over, superseding the second. The
 * two ping-ponged for ever with no backoff, each cycle spawning a pty and then
 * running the full kill ladder, and neither login could ever complete.
 */
export class AgentLoginRuns {
  private readonly byAgent = new Map<AgentId, LoginRun>();
  /**
   * Starts currently in flight, so a second one waits rather than races.
   *
   * `start` has two awaits before it records anything, and without this both of
   * two concurrent calls got past the cancel (the map is still empty), both
   * spawned, and the second `set` won. The loser was then unreachable: it is not
   * in `byAgent`, so `sweep`, `cancel` and `shutdown` all iterate straight past
   * it, and a pty plus the CLI under it sat on this host until the daemon
   * exited. Two tabs on the Settings screen is enough to do it, and
   * React's development double-mount does it every time.
   *
   * Serialising is the right answer rather than refusing the second call: the
   * supersede behaviour below is deliberate and has to keep working.
   */
  private readonly starting = new Map<string, Promise<LoginRunView | null>>();
  /**
   * Set by {@link shutdown}, and the reason it is not enough to drain the map.
   *
   * A `start` accepted just before SIGTERM is still inside `runtime.login` —
   * which resolves a binary off PATH and then spawns a pty — when shutdown
   * drains. Without this it then spawned *after* the drain, wrote itself into the
   * cleared map, and survived
   * `process.exit(0)` with no successor daemon aware of it: precisely the orphan
   * the `starting` map above exists to prevent, one layer up.
   */
  private stopped = false;
  private readonly runtime: SessionRuntime;
  private readonly onWarning: (detail: string) => void;
  /**
   * Drives {@link sweep} on a clock rather than on traffic. See `SWEEP_INTERVAL_MS`.
   *
   * `unref()` so it is not a reason for the process to stay alive: this is
   * housekeeping for something that is already abandoned, and a daemon whose only
   * remaining work is a cleanup timer should still exit.
   */
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(options: AgentLoginRunsOptions) {
    this.runtime = options.runtime;
    this.onWarning = options.onWarning ?? (() => {});
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** `null` when this runtime declines to drive logins — see `SessionRuntime.login`. */
  async start(agent: AgentId): Promise<LoginRunView | null> {
    if (this.stopped) return null;
    // Chained onto whatever start is already running for this agent,
    // so the cancel-then-spawn below is never interleaved with another copy of
    // itself. The predecessor's rejection is not ours to report, hence the swallow.
    const key = agent;
    const previous = this.starting.get(key);
    const attempt = (previous ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.doStart(agent));
    this.starting.set(key, attempt);
    try {
      return await attempt;
    } finally {
      // Only if nobody has queued behind us, or the next caller would clear a
      // promise it is itself waiting on.
      if (this.starting.get(key) === attempt) this.starting.delete(key);
    }
  }

  private async doStart(agent: AgentId): Promise<LoginRunView | null> {
    this.sweep();
    // This agent's previous run only. Cancelling the *other* agent's here is
    // what produced the ping-pong described on `byAgent`.
    await this.cancelRun(this.byAgent.get(agent));

    const process_ = await this.runtime.login(agent);
    if (process_ === null) return null;

    const run = new LoginRun(`li_${randomBytes(8).toString("hex")}`, agent, process_);
    // Checked *after* the await, not only at the top: shutdown may have run while
    // `runtime.login` was still spawning, and a run recorded into a map nobody
    // will drain again is an orphaned pty on this host.
    if (this.stopped) {
      await this.cancelRun(run);
      return null;
    }
    this.byAgent.set(agent, run);
    return run.view();
  }

  /** A page of the caller's own transcript. See {@link own} for the ownership rule. */
  read(loginId: string, since: number): LoginChunk | null {
    const run = this.own(loginId);
    return run === null ? null : run.read(since);
  }

  /**
   * Types one line into the caller's own run.
   *
   * A three-armed result rather than `LoginRunView | null`, because "no such
   * run" and "this flow reads no input" are different things to tell somebody
   * and the route answers them with different statuses. Collapsing them was the
   * shape of the old silent no-op: a device-code login on BSD has no stdin at
   * all, so a code typed into the box went nowhere and the response said it had
   * landed.
   */
  write(loginId: string, text: string): LoginWriteResult {
    const run = this.own(loginId);
    if (run === null) return { kind: "not_found" };
    if (!run.write(text)) return { kind: "not_interactive" };
    return { kind: "ok", view: run.view() };
  }

  /** Stops the caller's own run, named by id. Any agent of theirs; never anyone else's. */
  async cancel(loginId: string): Promise<boolean> {
    const run = this.own(loginId);
    if (run === null) return false;
    this.byAgent.delete(run.agent);
    await this.cancelRun(run);
    return true;
  }

  /**
   * Stops everything. Called from the daemon's shutdown path.
   *
   * Drains twice around the in-flight starts, and both halves are needed. The
   * `stopped` flag makes a start that has not spawned yet refuse; awaiting
   * `starting` catches the one that already has, because `doStart` re-checks the
   * flag after its awaits and disposes rather than recording. Draining `byAgent`
   * alone left whichever of those landed a microsecond later still running past
   * `process.exit(0)`.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.starting.values()]);
    const runs = [...this.byAgent.values()];
    this.byAgent.clear();
    await Promise.all(runs.map((run) => this.cancelRun(run)));
  }

  /**
   * The run this id names, if it is still the live one.
   *
   * Scanned and matched on the id rather than looked up from a map of ids, and
   * the reason changed rather than went away. It used to be an ownership check.
   * What it does now is stop a **superseded** wizard — one whose client has not
   * yet noticed it was replaced — reading or, worse, typing a one-time code into
   * its successor's stdin. At most one entry per agent, so the scan is two
   * comparisons.
   */
  private own(loginId: string): LoginRun | null {
    this.sweep();
    for (const run of this.byAgent.values()) {
      if (run.loginId === loginId) return run;
    }
    return null;
  }

  /** Disposes one run, reporting rather than throwing. `undefined` is a no-op. */
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

/** Matches a complete CSI/OSC/other escape sequence. */
const ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
/** The start of something that might be an escape sequence split across chunks. */
const PARTIAL_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?)?$/;

/**
 * Turns pty output into something a `<pre>` can show.
 *
 * These flows run under a real pty — that is the whole point of `script`, since
 * they refuse to prompt without one — so they draw with escape sequences. A
 * terminal emulator is far out of scope, and the alternative to stripping is a
 * pane full of `\x1b[2K\x1b[1G`.
 *
 * A lone `\r` becomes a newline rather than being dropped. It means "redraw this
 * line", so dropping it concatenates every frame of a spinner into one
 * unreadable line, and honouring it properly needs the emulator we are not
 * writing. Extra lines are the readable failure.
 *
 * `carry` holds back a trailing sequence that may be incomplete because the
 * chunk boundary fell inside it — without it, a split escape prints as text
 * exactly once per boundary, which is both ugly and impossible to reproduce.
 */
export function sanitize(input: string): { text: string; carry: string } {
  const partial = PARTIAL_ESCAPE.exec(input);
  // Only hold back a partial match that is genuinely at the end and not already
  // a complete sequence in its own right.
  const carry = partial !== null && partial[0].length > 0 ? partial[0] : "";
  const body = carry.length > 0 ? input.slice(0, input.length - carry.length) : input;
  return { text: scrub(body), carry };
}

/**
 * The replacement chain on its own, because there are two ways into this buffer.
 *
 * Named and split out for the carry flush in `LoginRun.append`: a carry that has
 * outgrown `MAX_CARRY_BYTES` is by that point ordinary output rather than an
 * escape sequence, so it takes this path too. Inline in `sanitize` it was
 * reachable only through the body, and the one caller that bypassed the body put
 * raw pty bytes — ESC included — into a transcript rendered in a `<pre>`.
 */
function scrub(body: string): string {
  return (
    body
      .replace(ESCAPE, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Backspace-erase, which these CLIs use while masking input.
      .replace(/[^\n]\x08/g, "")
      // Anything else non-printable would be noise in a transcript.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}
