// The plugin child: decides nothing. Rules: exit when IPC closes, answer every invocation exactly once, survive unhandled rejections.

import {
  MAX_PLUGIN_MESSAGE_BYTES,
  type ChildMessage,
  type HostMessage,
  type PluginInvokeKind,
} from "./runtime.js";
import { pluginContext } from "./context.js";
import { fitView, noteClamp, type PluginManifest, type PluginSurface } from "./protocol.js";

interface PluginModule {
  screen?: (ctx: unknown) => unknown;
  settings?: (ctx: unknown) => unknown;
  action?: (ctx: unknown, event: unknown) => unknown;
  hook?: (ctx: unknown, event: unknown) => unknown;
}

let plugin: PluginModule | null = null;
let manifest: PluginManifest | null = null;

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCallId = 1;

function post(message: ChildMessage): boolean {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) return false;
  try {
    process.send?.(text);
    return true;
  } catch {
    // The channel closed mid-write; disconnect is about to fire.
    return false;
  }
}

/** Keeps no deadline of its own: the host owns every one. */
function call(method: string, args: unknown): Promise<unknown> {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (!post({ t: "call", id, method, args })) {
      pending.delete(id);
      reject(new Error(`${method}: the request was too large to send`));
    }
  });
}

function context(): Record<string, unknown> {
  return pluginContext(call, { id: manifest?.id ?? null, version: manifest?.version ?? null });
}

/** A missing export is a refusal naming it, never an empty answer. */
async function dispatch(kind: PluginInvokeKind, name: string, input: unknown): Promise<unknown> {
  const module = plugin;
  if (module === null) throw new Error("this plugin has not finished loading");
  const ctx = context();

  if (kind === "view") {
    const fn = name === "settings" ? module.settings : module.screen;
    if (typeof fn !== "function") throw new Error(`this plugin exports no ${name === "settings" ? "settings" : "screen"}`);
    return normalize(await fn(ctx));
  }
  if (kind === "action") {
    if (typeof module.action !== "function") throw new Error("this plugin exports no action");
    const result = await module.action(ctx, input);
    // A void action result means say nothing; the host re-reads the screen.
    if (result === undefined || result === null) return null;
    return result;
  }
  if (typeof module.hook !== "function") return null;
  await module.hook(ctx, input);
  return null;
}

function normalize(result: unknown): unknown {
  if (Array.isArray(result)) return { title: null, blocks: result };
  return result;
}

const VIEW_BUDGET = MAX_PLUGIN_MESSAGE_BYTES - 1024;

/** Cut here, in the sending child, so an oversized view is clamped rather than refused by post. */
function fitted(value: unknown, surface: PluginSurface): unknown {
  if (value === null || value === undefined) return value;
  const one = value as { kind?: unknown; view?: unknown };
  if (one.kind === "toast") return value;
  if (one.kind === "view") return { kind: "view", view: noteClamp(fitView(one.view, VIEW_BUDGET, surface), surface) };
  return noteClamp(fitView(value, VIEW_BUDGET, surface), surface);
}

process.on("message", (raw: unknown) => {
  if (typeof raw !== "string") return;
  let message: HostMessage;
  try {
    message = JSON.parse(raw) as HostMessage;
  } catch {
    // Dropped: every deadline is the host's, and exiting would spend a restart on a bad message.
    return;
  }

  if (message.t === "init") {
    manifest = message.manifest;
    void (async () => {
      try {
        plugin = (await import(message.entry)) as PluginModule;
        post({ t: "ready" });
      } catch (error) {
        post({ t: "fail", error: describe(error) });
      }
    })();
    return;
  }

  if (message.t === "answer") {
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(message.error));
    return;
  }

  if (message.t === "invoke") {
    const { id } = message;
    void (async () => {
      try {
        // An action cannot know which pane it came from, so it counts as screen; the client narrows what it draws.
        const surface: PluginSurface = message.kind === "view" && message.name === "settings" ? "settings" : "screen";
        const value = fitted(await dispatch(message.kind, message.name, message.input), surface);
        // Exactly once: a result too large to send still gets an answer.
        if (!post({ t: "done", id, ok: true, value })) {
          post({ t: "done", id, ok: false, error: "this plugin returned more than can be sent" });
        }
      } catch (error) {
        // Rule 2: the invocation is answered even if the failure path fails.
        try {
          post({ t: "done", id, ok: false, error: describe(error) });
        } catch {
          post({ t: "done", id, ok: false, error: "this plugin failed and could not say how" });
        }
      }
    })();
  }
});

process.on("disconnect", () => {
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  // The host shows the last stderr lines on the plugin's row; not fatal on purpose.
  process.stderr.write(`[unhandled] ${describe(reason)}\n`);
});

/** Never throws, even when the thrown value's message getter or toString does: rule 2. */
function describe(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === "string" ? message : "this plugin threw something that will not describe itself";
    }
    return String(error);
  } catch {
    return "this plugin threw something that will not describe itself";
  }
}
