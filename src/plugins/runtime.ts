import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PluginManifest } from "./protocol.js";

/** A backstop, not a defence: Node IPC holds a message before its length can be read; runner.ts bounds it before sending. */
export const MAX_PLUGIN_MESSAGE_BYTES = 256 * 1024;

export const MAX_INFLIGHT_INVOCATIONS = 8;

export const MAX_INFLIGHT_HOST_CALLS = 16;

export const PLUGIN_INVOKE_TIMEOUT_MS = 10_000;

export const PLUGIN_START_TIMEOUT_MS = 10_000;

export const PLUGIN_STOP_GRACE_MS = 2_000;

// Stop must always resolve: install holds the daemon's one install slot across it.
const PLUGIN_STOP_DEADLINE_MS = PLUGIN_STOP_GRACE_MS * 2;

export const PLUGIN_LOG_LINES = 20;

const MAX_LOG_LINE_CHARS = 4_000;

export type HostMessage =
  | { t: "init"; manifest: PluginManifest; entry: string }
  | { t: "invoke"; id: number; kind: PluginInvokeKind; name: string; input: unknown }
  | { t: "answer"; id: number; ok: true; value: unknown }
  | { t: "answer"; id: number; ok: false; error: string };

export type ChildMessage =
  | { t: "ready" }
  | { t: "fail"; error: string }
  | { t: "done"; id: number; ok: true; value: unknown }
  | { t: "done"; id: number; ok: false; error: string }
  | { t: "call"; id: number; method: string; args: unknown };

export type PluginInvokeKind = "view" | "action" | "hook";

export interface PluginProcess {
  send(message: HostMessage): boolean;
  /** Resolves once nothing more will be written to this child, not once it is gone: a wedged pid is given up on. */
  stop(): Promise<void>;
  recentLogs(): readonly string[];
}

export interface PluginLaunch {
  manifest: PluginManifest;
  entry: string;
  /** The only thing saying which child a message came from; call ids restart per launch (see LivePlugin.generation). */
  onMessage: (message: ChildMessage) => void;
  onExit: (detail: string) => void;
}

export interface PluginRuntime {
  launch(options: PluginLaunch): Promise<PluginProcess>;
}

/** Not detached, since runner.ts exits when its IPC channel closes; REEMOAT_* is stripped as hygiene, not a fence. */
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
  // Node emits error both for a failed spawn and for a failed send or kill on a live child; spawn separates the two.
  private spawned = false;
  private readonly ended: Promise<void>;

  constructor(options: PluginLaunch) {
    let over: () => void = () => undefined;
    this.ended = new Promise<void>((resolve) => {
      over = resolve;
    });

    // Inherits tsx's execArgv so runner.ts compiles; a plugin's own server.js must still be plain JavaScript.
    this.child = fork(fileURLToPath(new URL("./runner.ts", import.meta.url)), [], {
      env: pluginEnv(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });

    const keep = (line: string): void => {
      this.logs.push(line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}…` : line);
      while (this.logs.length > PLUGIN_LOG_LINES) this.logs.shift();
    };
    lines(this.child.stdout, keep);
    lines(this.child.stderr, keep);

    this.child.on("message", (raw) => {
      if (typeof raw !== "string") return;
      const size = Buffer.byteLength(raw, "utf8");
      if (size > MAX_PLUGIN_MESSAGE_BYTES) {
        keep(`[reemoat] a message of ${size} bytes was dropped; the limit is ${MAX_PLUGIN_MESSAGE_BYTES}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      options.onMessage(parsed as ChildMessage);
    });

    // A failed spawn may never emit exit, so close and a pre-spawn error also finish, exactly once.
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
    if (Buffer.byteLength(text, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) {
      return false;
    }
    try {
      this.child.send(text);
      return true;
    } catch {
      return false;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.gone) return;
    // Signal only with a pid in hand: before one is assigned, kill targets the daemon's own process group.
    const signal = (which: "SIGTERM" | "SIGKILL"): void => {
      if (this.child.pid !== undefined) this.child.kill(which);
    };
    signal("SIGTERM");
    const killer = setTimeout(() => {
      signal("SIGKILL");
    }, PLUGIN_STOP_GRACE_MS);
    // Raced against a deadline: a pid wedged on a hung mount is never reaped, and nothing would ever settle.
    let giveUp: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      giveUp = setTimeout(resolve, PLUGIN_STOP_DEADLINE_MS);
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

function pluginEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("REEMOAT_")) delete env[key];
  }
  return env;
}

function exitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `killed by ${signal}` : `exited with code ${code ?? 0}`;
}

function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return;
  let held = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    held += chunk;
    // The per-newline slice is O(1) since V8 returns a sliced string; one split per chunk measured slower.
    let index = held.indexOf("\n");
    while (index >= 0) {
      onLine(held.slice(0, index));
      held = held.slice(index + 1);
      index = held.indexOf("\n");
    }
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
