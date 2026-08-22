import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PluginManifest } from "./protocol.js";

/**
 * Where a plugin's code runs, and the one implementation of it.
 *
 * **An interface with a single implementation, kept as one on purpose** — the
 * same decision `SessionRuntime` records one directory up, and for the same two
 * reasons. It is the seam a sandbox would be written at if one is ever wanted;
 * and it is what lets `daemoncheck` drive every lifecycle rule — a timeout, a
 * crash, the restart budget, a child that never answers — without spawning
 * anything, which is the difference between those paths being asserted and being
 * hoped for.
 *
 * ⚠ There is deliberately **no `kind` discriminant** on this interface, for the
 * reason `SessionRuntime`'s own docblock gives: an unread discriminant is how an
 * `if (kind === "sandboxed")` branch against nothing comes to be written.
 */

/**
 * How large one IPC message may be, in the JSON both sides speak.
 *
 * ⚠ **This is a bound against a mistake, not against the child.** Node's IPC has
 * no framing limit anyone can set, so a message is already resident by the time
 * its length can be read — the check on receipt is a backstop that stops a large
 * view being *forwarded* to a phone, not one that stops it arriving. The bound
 * that does real work is the one in `runner.ts`, applied before the child sends;
 * a plugin that bypasses its own runner is a plugin running arbitrary code as
 * this uid, which is the honest description of every plugin.
 *
 * Messages are sent as **strings** rather than objects for exactly this: with
 * `child.send(object)` the length is not knowable without serialising the thing
 * again, which is the cost the bound exists to avoid.
 */
export const MAX_PLUGIN_MESSAGE_BYTES = 256 * 1024;

/**
 * How many invocations one plugin may be answering at once.
 *
 * Published in both bounds tables from the start and enforced nowhere, which
 * made it the one row in either table with no constant behind it. What it
 * actually holds back: `pending` is a `Map` with a timer per entry, the view
 * route is `read`-scoped, and `PluginScreen` re-reads on an interval — so a
 * handful of tabs on a slow plugin could hold an unbounded number of open HTTP
 * requests and timers against a child answering them one at a time.
 */
export const MAX_INFLIGHT_INVOCATIONS = 8;

/** How long a plugin gets to answer before the request is abandoned. */
export const PLUGIN_INVOKE_TIMEOUT_MS = 10_000;

/** How long a plugin gets to say `ready` after it is launched. */
export const PLUGIN_START_TIMEOUT_MS = 10_000;

/** SIGTERM, then this long, then SIGKILL. */
export const PLUGIN_STOP_GRACE_MS = 2_000;

/**
 * How long a stop waits in total before it stops waiting.
 *
 * ⚠ **Not a fourth deadline in the bounds table — the backstop under the third.**
 * `stop()` resolves when the child is *observed* gone, and everything above it
 * treats that as a fact: `PluginHost.install` awaits it inside a `try` whose
 * `finally` clears the one-install-at-a-time mutex, and `shutdown` awaits all of
 * them at once. A stop that can never resolve therefore does not delay an install,
 * it ends installing on this machine until somebody restarts the daemon. Derived
 * from the grace rather than written as its own number so it cannot drift away
 * from it: SIGTERM, two seconds, SIGKILL, two more, and then it is reported as
 * over whether or not the kernel agreed.
 */
const PLUGIN_STOP_DEADLINE_MS = PLUGIN_STOP_GRACE_MS * 2;

/** How many lines of a child's own output are kept for the failure a screen shows. */
export const PLUGIN_LOG_LINES = 20;

/** How long one of those lines may be before it is cut. A plugin logging a whole file is not a log. */
const MAX_LOG_LINE_CHARS = 4_000;

/** What the host says to the child. */
export type HostMessage =
  | { t: "init"; manifest: PluginManifest; entry: string }
  | { t: "invoke"; id: number; kind: PluginInvokeKind; name: string; input: unknown }
  | { t: "answer"; id: number; ok: true; value: unknown }
  | { t: "answer"; id: number; ok: false; error: string };

/** What the child says to the host. */
export type ChildMessage =
  | { t: "ready" }
  | { t: "fail"; error: string }
  | { t: "done"; id: number; ok: true; value: unknown }
  | { t: "done"; id: number; ok: false; error: string }
  | { t: "call"; id: number; method: string; args: unknown };

/**
 * Which of a plugin's three entry points is being called.
 *
 * The child is told, and the difference is a **contract rather than a
 * mechanism**: a `view` is reached by `GET` and `isReplayable` therefore allows
 * the transport to repeat it, so a view that writes is a bug a retry will find.
 * Nothing here can enforce that — a plugin is arbitrary code — and saying which
 * kind of call this is at least means an author who reads the API knows which
 * side of the line they are on.
 */
export type PluginInvokeKind = "view" | "action" | "hook";

export interface PluginProcess {
  /**
   * `false` when nothing was written — past {@link MAX_PLUGIN_MESSAGE_BYTES}, or
   * once stopped.
   *
   * ⚠ **The answer is returned rather than swallowed**, because the two callers
   * both have somebody waiting. A dropped `invoke` used to be indistinguishable
   * from a hung child, so an oversized form spent the full invoke deadline and
   * three of them stopped the plugin; a dropped `answer` left the child's own
   * promise pending for ever. Both now fail at once and say why.
   */
  send(message: HostMessage): boolean;
  /** Idempotent, and resolves once the child is gone. `this.x ??= this.doX()`. */
  stop(): Promise<void>;
  /** The last lines the child wrote to stdout or stderr. Shown on its row when it fails. */
  recentLogs(): readonly string[];
}

export interface PluginLaunch {
  manifest: PluginManifest;
  /** Absolute path to the plugin's own `server.js`. */
  entry: string;
  /**
   * A message the child sent. Already length-checked and parsed; never trusted for
   * shape.
   *
   * ⚠ **And never trusted for *whose* it is, either: this callback is the only
   * thing that says which child a message came from.** Nothing in a message
   * carries an incarnation — a child's own call ids restart at 1 on every launch,
   * because `runner.ts` is a fresh process with a fresh `nextCallId` — so a host
   * that answers "whichever child is current" rather than "the child this callback
   * was made for" settles one incarnation's request with another's answer, which
   * is silent wrong data inside somebody's plugin. `LivePlugin.generation` is how
   * that is kept straight on the other side of this interface.
   */
  onMessage: (message: ChildMessage) => void;
  /**
   * The child is gone, for any reason including {@link PluginProcess.stop}.
   *
   * ⚠ **Arbitrarily late, which is the half a caller gets wrong.** A SIGTERM'd
   * child has {@link PLUGIN_STOP_GRACE_MS} before it is killed and
   * `PLUGIN_STOP_DEADLINE_MS` before `stop()` gives up waiting for it at all — so
   * this fires against a host that may well have launched a replacement in the
   * meantime, and it fires for a child that has been superseded just as it does
   * for the current one. Same rule as {@link onMessage}: it is about the launch it
   * was made for and about nothing else.
   */
  onExit: (detail: string) => void;
}

export interface PluginRuntime {
  launch(options: PluginLaunch): Promise<PluginProcess>;
}

/**
 * A plugin in a child process of this daemon.
 *
 * **Not `detached`, and that is the opposite of what agents do.** An agent is
 * spawned detached because `claude-agent-acp` runs the CLI as its own child and
 * cleans up only on `process.on("exit")`, so the group is the only thing that can
 * be killed reliably — which is why there is a pid column, an `os.uptime()` fence
 * and a reaper. A plugin needs none of that: `runner.ts` exits when its IPC
 * channel closes, so a daemon that dies takes its plugins with it without anybody
 * recording a pid. There is deliberately no plugin equivalent of orphan reaping,
 * and this is the sentence that says why one is not missing.
 *
 * **The environment is stripped the way `agentEnv()` strips an agent's**, and it
 * is the same *hygiene, not a fence*: the child runs as this uid and can read
 * `/proc/<pid>/environ`, the env file and the database. What it prevents is three
 * accidents — a plugin echoing `REEMOAT_TOKEN` into a view somebody screenshots,
 * a plugin running `pnpm daemon` and colliding on the daemon lock, and a plugin
 * opening `REEMOAT_DB` under the daemon that holds it.
 */
export class ForkedPluginRuntime implements PluginRuntime {
  launch(options: PluginLaunch): Promise<PluginProcess> {
    return Promise.resolve(new ForkedPlugin(options));
  }
}

class ForkedPlugin implements PluginProcess {
  private readonly child: ChildProcess;
  private readonly logs: string[] = [];
  private stopping: Promise<void> | null = null;
  private gone = false;
  /**
   * Whether this child ever existed, which is what makes `'error'` readable.
   *
   * Node emits `'error'` both for a spawn that never happened and for a `send` or
   * a `kill` that failed against a child which is still very much alive, and the
   * two mean opposite things here. `'spawn'` is what separates them.
   */
  private spawned = false;
  /** Settles the first time this child is known to be gone. See `finish` below. */
  private readonly ended: Promise<void>;

  constructor(options: PluginLaunch) {
    let over: () => void = () => undefined;
    this.ended = new Promise<void>((resolve) => {
      over = resolve;
    });

    /*
     * `execArgv` is inherited, which is what makes a `.ts` runner work at all.
     *
     * Measured 2026-08-21 on Node 24: a parent started by `tsx` carries
     * `--require …/tsx/dist/preflight.cjs --import …/tsx/dist/loader.mjs` in
     * `process.execArgv`, `fork` passes it on, and the child compiles TypeScript.
     * That is not a new assumption — nothing in `src/` or `scripts/` has a build
     * step and `deploy/run-daemon.sh` execs `tsx` directly — but it is the first
     * place the assumption is load-bearing *at runtime* rather than at start, so
     * it is written down where somebody removing tsx will find it.
     *
     * ⚠ It also means a plugin's own `server.js` may today be TypeScript, because
     * the loader is already installed. **That is not the contract and will not be
     * kept.** A plugin is somebody else's artifact and must not depend on this
     * daemon's toolchain; `docs/PLUGINS.md` says plain JavaScript.
     */
    this.child = fork(fileURLToPath(new URL("./runner.ts", import.meta.url)), [], {
      env: pluginEnv(),
      // stdin is `ignore` rather than `pipe`: nothing writes to a plugin, and a
      // pipe nobody drains is a plugin that blocks on its own `console.log` once
      // the buffer fills.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });

    const keep = (line: string): void => {
      this.logs.push(line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}…` : line);
      while (this.logs.length > PLUGIN_LOG_LINES) this.logs.shift();
    };
    // stdout as well as stderr, into one ring. A plugin author's `console.log` is
    // the first thing they will reach for, and a log that goes nowhere is a
    // debugging session spent finding out it went nowhere.
    lines(this.child.stdout, keep);
    lines(this.child.stderr, keep);

    this.child.on("message", (raw) => {
      if (typeof raw !== "string") return;
      // Bytes, not UTF-16 code units. `checkPluginWrite` already writes this rule
      // out for the store quota — `.length` counts units, and what crosses the pipe
      // is UTF-8 — and the number here is called bytes in the Bounds table and in
      // the drop message below, so charging `.length` let a CJK or emoji payload
      // through at up to three times the stated ceiling.
      const size = Buffer.byteLength(raw, "utf8");
      if (size > MAX_PLUGIN_MESSAGE_BYTES) {
        keep(`[reemoat] a message of ${size} bytes was dropped; the limit is ${MAX_PLUGIN_MESSAGE_BYTES}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A child that is not speaking this protocol. Dropped rather than fatal:
        // the invocation it belonged to times out and says so, which is a better
        // sentence than "the plugin sent something unparseable".
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      options.onMessage(parsed as ChildMessage);
    });

    /**
     * The child is gone, whatever told us so, and told exactly once.
     *
     * ⚠ **`'exit'` is not the only way a child ends, and treating it as the only
     * way wedged the whole daemon's install path.** Measured on Node 26 by
     * forking twice: a module path that does not exist gives `spawn`,
     * `disconnect`, `exit(1)`, `close(1)` — but a spawn that *fails*, driven here
     * with an `execPath` that does not exist, gives `error(ENOENT)`, `disconnect`,
     * `close(-2)` and **no `'exit'` at all**. That is what the docs mean by "the
     * `'exit'` event may or may not fire after an error has occurred", and it is
     * the shape EMFILE, EAGAIN and ENOMEM arrive in. With `'exit'` as the only
     * listener, `gone` stayed false and the promise `doStop` awaits never settled,
     * so `PluginHost.install`'s `await this.stop()` hung *inside* its `try`: the
     * `finally` never ran, `installing` stayed `true`, and every later
     * `POST /plugins` answered `409 plugin_busy` until the daemon was restarted.
     * `shutdown` and `invoke` hang on the same promise.
     *
     * `'close'` is the belt because it fired in both measurements; `'error'` is
     * the second belt for the case the docs decline to promise either, and it is
     * terminal only before `'spawn'` for the reason {@link ForkedPlugin.spawned}
     * gives.
     */
    const finish = (detail: string): void => {
      if (this.gone) return;
      this.gone = true;
      over();
      options.onExit(detail);
    };

    this.child.once("spawn", () => {
      this.spawned = true;
    });

    this.child.on("error", (error) => {
      keep(`[reemoat] ${error.message}`);
      // Before `spawn` this is the only event that will ever say what went wrong —
      // `close`, if it comes at all, carries `-2` and no message — so it is both
      // the terminal signal and the sentence the plugin's row will show.
      if (!this.spawned) finish(`could not be started: ${error.message}`);
    });

    this.child.on("exit", (code, signal) => {
      finish(exitDetail(code, signal));
    });

    this.child.on("close", (code, signal) => {
      finish(exitDetail(code, signal));
    });
  }

  send(message: HostMessage): boolean {
    if (this.gone || this.stopping !== null) return false;
    const text = JSON.stringify(message);
    // Bytes rather than UTF-16 code units, for the reason the receive side states.
    if (Buffer.byteLength(text, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) {
      // Refused here rather than at the call site, so there is one place that
      // knows the bound. The caller settles whoever was waiting on it.
      return false;
    }
    try {
      this.child.send(text);
      return true;
    } catch {
      // The channel closed between the check and the write. The exit handler has
      // it, or is about to.
      return false;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.gone) return;
    /*
     * ⚠ **A signal is sent only with a pid in hand, and this is not defensive
     * tidiness — the unguarded version signals the daemon's own process group.**
     * Measured 2026-08-22 on Node 26, forking with an interpreter that does not
     * exist: in the window between `fork()` returning and the `nextTick` that
     * emits `'error'`, `child.pid` is `undefined` while `child._handle` is still
     * set, so `kill()` takes the handle path into libuv's `uv_kill(handle->pid,
     * …)` with `pid` never assigned — which is POSIX `kill(0, SIGTERM)`, "every
     * process in the caller's group". The probe reported `kill() returned true`
     * and then caught its own SIGTERM. A plugin whose spawn fails for the ordinary
     * reasons — EMFILE, EAGAIN, ENOMEM, a missing interpreter — could therefore
     * take the daemon down with it, and every session on the machine with it.
     * There is nothing to signal in that window anyway: the `'error'` handler
     * reaches `finish` on the next tick, and the deadline below covers the rest.
     */
    const signal = (which: "SIGTERM" | "SIGKILL"): void => {
      if (this.child.pid !== undefined) this.child.kill(which);
    };
    signal("SIGTERM");
    const killer = setTimeout(() => {
      // SIGKILL is what follows the grace, and nothing follows SIGKILL. A plugin
      // holds no conversation, so there is nothing to lose by being abrupt.
      signal("SIGKILL");
    }, PLUGIN_STOP_GRACE_MS);
    /*
     * ⚠ **Raced, and the race is not belt-and-braces over `finish`.** `finish`
     * fixes the child this process can see; the deadline covers the one it cannot
     * — a pid wedged in uninterruptible sleep on a hung mount, where SIGKILL is
     * accepted and the process is never reaped, so no event ever comes. `stop()`
     * is awaited by `install` inside the block that holds the daemon's one
     * install slot, and a stop that cannot end is not a slow install: it is no
     * more installs on this machine, ever. Resolving early is safe because the
     * only thing `stop` promises callers is that nothing more will be written to
     * this child, and `send` refuses on `stopping` rather than on `gone`.
     */
    let giveUp: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      giveUp = setTimeout(resolve, PLUGIN_STOP_DEADLINE_MS);
      // Unref'd like every other backstop timer here: waiting to be sure a plugin
      // died is not a reason for this process to stay up.
      giveUp.unref?.();
    });
    try {
      await Promise.race([this.ended, deadline]);
    } finally {
      clearTimeout(killer);
      clearTimeout(giveUp);
    }
  }

  recentLogs(): readonly string[] {
    return this.logs;
  }
}

/**
 * What a plugin's process starts with.
 *
 * The `REEMOAT_` half of what `agentEnv()` strips, and the same standing this
 * file's class docblock gives it. Written out here rather than imported from
 * `src/acp/agents.ts` because that function's list is about *an agent* — it
 * strips `CLAUDE_*` names an ACP session sets — and a shared list would mean one
 * subsystem's addition silently changing the other's behaviour.
 */
function pluginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("REEMOAT_")) delete env[key];
  }
  return env;
}

/** How a child's departure reads on its row. One sentence, two events reach it. */
function exitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 0}`;
}

/** A stream split into lines, bounded, with the tail flushed on end. */
function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return;
  let held = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    held += chunk;
    /*
     * ⚠ **`held.slice(index + 1)` per newline is not the quadratic copy it looks
     * like, and this loop was rewritten as one `split` per chunk on that reading
     * before the rewrite was taken back out.** V8 returns a `SlicedString` — a
     * view sharing the parent's backing store — for any slice of 13 characters or
     * more, so consuming a line is O(1) and the loop is linear in the chunk.
     * Measured 2026-08-22 on Node 26, 8 MiB of a plugin `console.log`ing in a
     * loop delivered as 129 pipe chunks of 64 KiB: 11–13 ms either way, and the
     * `split` version was the slower of the two at 4 MiB of short lines (26 ms
     * against 13) because it allocates an array of a million strings the loop
     * never needs. Retention is identical too — `split`'s tail is a `SlicedString`
     * holding the whole chunk exactly as `held` is, 200 MiB either way over 200
     * chunks of 1 MiB with a 40-character partial line at the end.
     */
    let index = held.indexOf("\n");
    while (index >= 0) {
      onLine(held.slice(0, index));
      held = held.slice(index + 1);
      index = held.indexOf("\n");
    }
    // A child writing without newlines must not grow this string for ever.
    if (held.length > MAX_LOG_LINE_CHARS) {
      onLine(held.slice(0, MAX_LOG_LINE_CHARS));
      held = "";
    }
  });
  stream.on("end", () => {
    if (held.length > 0) onLine(held);
  });
  stream.on("error", () => {
    // The child died mid-write. Its exit is the event that matters.
  });
}
