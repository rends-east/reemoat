/**
 * What a plugin's child process actually runs.
 *
 * This file is the plugin author's whole view of this daemon: it imports their
 * `server.js`, hands it a `ctx` whose every method is a round trip back to the
 * host, and turns whatever they return into one message. **Nothing here decides
 * anything** — the scope gate, the bounds and the timeouts are all on the host
 * side, because a check inside the process being checked is a check the process
 * can delete.
 *
 * Three rules it does keep, all of them about not being the reason something
 * hangs:
 *
 *   1. **It exits when the IPC channel closes.** That is the entire lifecycle
 *      story — no pid table, no reaper, no `os.uptime()` fence. A daemon that
 *      dies, gracefully or not, leaves children whose `disconnect` fires, and
 *      they go.
 *   2. **Every invocation answers exactly once**, including when the plugin
 *      throws, returns a promise that rejects, or returns something enormous. An
 *      invocation with no answer is a request the host times out and a person
 *      waits ten seconds for.
 *   3. **An unhandled rejection anywhere else is reported, not fatal.** A plugin
 *      that floats a promise should not take its own screens down.
 */

import {
  MAX_PLUGIN_MESSAGE_BYTES,
  type ChildMessage,
  type HostMessage,
  type PluginInvokeKind,
} from "./runtime.js";
import type { PluginManifest } from "./protocol.js";

/** What a plugin's module may export. Every one is optional; missing means "not offered". */
interface PluginModule {
  screen?: (ctx: unknown) => unknown;
  settings?: (ctx: unknown) => unknown;
  action?: (ctx: unknown, event: unknown) => unknown;
  hook?: (ctx: unknown, event: unknown) => unknown;
}

let plugin: PluginModule | null = null;
let manifest: PluginManifest | null = null;

/** Calls this process has made to the host and is still waiting on. */
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextCallId = 1;

function post(message: ChildMessage): boolean {
  const text = JSON.stringify(message);
  // Bytes rather than UTF-16 code units, as `runtime.ts` charges on both of its sides.
  if (Buffer.byteLength(text, "utf8") > MAX_PLUGIN_MESSAGE_BYTES) return false;
  try {
    process.send?.(text);
    return true;
  } catch {
    // The channel went while we were writing. `disconnect` is about to fire.
    return false;
  }
}

/**
 * One call from the plugin back into the host.
 *
 * Never rejects on a timeout of its own: the host owns every deadline in this
 * subsystem, and a second one here would mean two different answers to "how long
 * is too long" that could disagree. What happens if the host never answers is
 * that the *invocation* times out, which is the deadline a person is actually
 * waiting behind.
 */
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

/**
 * The plugin's whole view of this machine.
 *
 * Shaped as plain namespaced functions rather than a class, because it is
 * documented in `docs/PLUGINS.md` and read by people writing twenty lines of
 * JavaScript. Every one of these is refused by the host unless the manifest
 * declared the matching scope — including inside a hook, where there is no
 * caller at all and the manifest is the only authority there is.
 */
function context(): Record<string, unknown> {
  return {
    plugin: { id: manifest?.id ?? null, version: manifest?.version ?? null },
    log: (message: unknown) => call("log", { message: String(message) }),
    sessions: {
      list: () => call("sessions.list", {}),
      get: (id: unknown) => call("sessions.get", { id }),
      events: (id: unknown, options: unknown) => call("sessions.events", { id, ...(options as object) }),
      changes: (id: unknown) => call("sessions.changes", { id }),
      diff: (id: unknown, path: unknown) => call("sessions.diff", { id, path }),
      workspace: (id: unknown) => call("sessions.workspace", { id }),
      create: (options: unknown) => call("sessions.create", options),
      prompt: (id: unknown, text: unknown) => call("sessions.prompt", { id, text }),
      cancel: (id: unknown) => call("sessions.cancel", { id }),
      stop: (id: unknown) => call("sessions.stop", { id }),
      setMeta: (id: unknown, meta: unknown) => call("sessions.setMeta", { id, ...(meta as object) }),
      answerPermission: (id: unknown, permissionId: unknown, optionId: unknown) =>
        call("sessions.answerPermission", { id, permissionId, optionId }),
      // The other half of `answerPermission`. Spread like `setMeta` because the
      // host reads `decline`/`cancel`/`content` off the same object the call
      // carries, rather than a nested one.
      answerElicitation: (id: unknown, elicitationId: unknown, body: unknown) =>
        call("sessions.answerElicitation", { id, elicitationId, ...(body as object) }),
    },
    agents: {
      list: () => call("agents.list", {}),
    },
    files: {
      // `read` and no `list`: the host's table deliberately has no `files.list`,
      // and offering one here bought a plugin author an `unknown_method` at
      // runtime instead of an error they could read.
      read: (sessionId: unknown, path: unknown) => call("files.read", { sessionId, path }),
    },
    store: {
      get: (key: unknown) => call("store.get", { key }),
      set: (key: unknown, value: unknown) => call("store.set", { key, value }),
      delete: (key: unknown) => call("store.delete", { key }),
      keys: (prefix: unknown) => call("store.keys", { prefix }),
      // `keys` and then a `get` each is what an author writes when this is not
      // here, and it is a round trip per key: the reference plugin's board did
      // exactly that, at 2002 messages for the 1000 keys a plugin may hold. This
      // is one query, answered as `{entries, more}` — `more` means the page hit
      // the host's byte budget, and the next one starts after the last key it
      // handed back.
      entries: (prefix: unknown, after: unknown) => call("store.entries", { prefix, after }),
    },
    net: {
      fetch: (url: unknown, init: unknown) => call("net.fetch", { url, init }),
    },
  };
}

/**
 * Which export answers this invocation.
 *
 * A missing export is a refusal with a sentence naming it, rather than an empty
 * answer: a plugin whose manifest contributes a screen and whose module exports
 * no `screen` is a mistake somebody wants told, and an empty screen is how it
 * goes unnoticed for a week.
 */
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
    // A void return is the ordinary case for an action that only changes state,
    // and it means "say nothing" rather than "draw nothing" — the host turns it
    // into a re-read of whatever screen the press came from.
    if (result === undefined || result === null) return null;
    return result;
  }
  if (typeof module.hook !== "function") return null;
  await module.hook(ctx, input);
  return null;
}

/**
 * A view, in the one shape the host clamps.
 *
 * Returning a bare array of blocks is accepted as well as `{title, blocks}`,
 * which is the one convenience in this whole API. It is here rather than in
 * `clampView` because it is about how a *plugin author* writes a function, not
 * about what the wire carries — `clampView` sees one shape and only one.
 */
function normalize(result: unknown): unknown {
  if (Array.isArray(result)) return { title: null, blocks: result };
  return result;
}

process.on("message", (raw: unknown) => {
  if (typeof raw !== "string") return;
  let message: HostMessage;
  try {
    message = JSON.parse(raw) as HostMessage;
  } catch {
    return;
  }

  if (message.t === "init") {
    manifest = message.manifest;
    void (async () => {
      try {
        // `import()` of an absolute path the host resolved. The host is the only
        // thing that decides what file this is; nothing here joins a path.
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
        const value = await dispatch(message.kind, message.name, message.input);
        // Exactly once, and the fallback is still an answer: a result too large
        // to send must not become an invocation that never returns.
        if (!post({ t: "done", id, ok: true, value })) {
          post({ t: "done", id, ok: false, error: "this plugin returned more than can be sent" });
        }
      } catch (error) {
        post({ t: "done", id, ok: false, error: describe(error) });
      }
    })();
  }
});

process.on("disconnect", () => {
  // The daemon is gone, gracefully or not. This is the whole of plugin cleanup.
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  // Reported through the child's own stderr, which the host keeps as the last
  // twenty lines and shows on the plugin's row. Deliberately not fatal: a floated
  // promise in one handler must not take the plugin's screens down.
  process.stderr.write(`[unhandled] ${describe(reason)}\n`);
});

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
