/**
 * The plugin's whole view of this machine.
 *
 * Shaped as plain namespaced functions rather than a class, because it is
 * documented in `docs/PLUGINS.md` and read by people writing twenty lines of
 * JavaScript. Every one of these is refused by the host unless the manifest
 * declared the matching scope — including inside a hook, where there is no caller
 * at all and the manifest is the only authority there is.
 *
 * ⚠ **Its own file, and it is here because of the bug that put it here.**
 * `model.complete` was added to the host's `SCOPE_OF`, to the dispatcher, to the
 * consent screen and to a driver sweep — and never to this object. So the method
 * was built, authorized, documented and **unreachable**: `ctx.model` was
 * `undefined`, and a plugin calling it got a `TypeError` before any IPC happened.
 * Eight drivers were green, because every one of them tested the host's half.
 *
 * This lived inside `runner.ts`, which is a child process's entry point: importing
 * it registers `process.on` handlers, so no driver could reach in without changing
 * the behaviour of the process doing the checking. Pulled out here it is a plain
 * function of its own `call`, which is what lets `daemoncheck` sweep the host's
 * whole method table against it and assert that every method a plugin is allowed
 * to call is a method a plugin can *reach*.
 *
 * Nothing here decides anything, which is `runner.ts`'s rule and unchanged: the
 * scope gate, the bounds and the timeouts are all on the host side, because a
 * check inside the process being checked is a check that process can delete.
 */

/** One round trip to the host. Injected, so a driver can watch what is asked for. */
export type PluginCall = (method: string, args: unknown) => Promise<unknown>;

export function pluginContext(
  call: PluginCall,
  plugin: { id: string | null; version: string | null },
): Record<string, unknown> {
  return {
    plugin,
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
    /*
     * ⚠ **The branch this whole file was extracted over.** `model.complete` had a
     * scope, a dispatcher arm, a consent sentence and a driver case, and no line
     * here — so a plugin calling it got `Cannot read properties of undefined
     * (reading 'complete')` before a byte crossed the IPC channel. Found by
     * pressing the button on a real machine; not found by eight green drivers,
     * every one of which tested the host's half.
     *
     * Spread rather than nested, as `sessions.create` is: the host reads `agent`
     * and `prompt` off the object the call carries.
     */
    model: {
      complete: (options: unknown) => call("model.complete", { ...(options as object) }),
      /*
       * ⚠ **Added here at the same moment as the host's arm, which is the whole
       * lesson of the branch above.** `model.complete` shipped with a scope, a
       * dispatcher arm, a consent sentence and a driver case and *no line in this
       * object*; the sweep in `daemoncheck` that now walks `METHODS` against a
       * recording `call` exists because eight green drivers did not catch it. A
       * method added to `SCOPE_OF` and not to this file is a method that throws in
       * the child before a byte crosses the channel.
       */
      list: (options: unknown) => call("model.list", { ...(options as object) }),
    },
  };
}
