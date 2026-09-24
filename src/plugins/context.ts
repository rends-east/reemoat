// The plugin's ctx; every method is scope-gated on the host side, never here.
// A host method missing from this object is unreachable, so daemoncheck sweeps the host's method table against it.

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
      // Spread: the host reads decline, cancel and content off the call's own object.
      answerElicitation: (id: unknown, elicitationId: unknown, body: unknown) =>
        call("sessions.answerElicitation", { id, elicitationId, ...(body as object) }),
    },
    agents: {
      list: () => call("agents.list", {}),
    },
    files: {
      // No list: the host's method table has none.
      read: (sessionId: unknown, path: unknown) => call("files.read", { sessionId, path }),
    },
    store: {
      get: (key: unknown) => call("store.get", { key }),
      set: (key: unknown, value: unknown) => call("store.set", { key, value }),
      delete: (key: unknown) => call("store.delete", { key }),
      keys: (prefix: unknown) => call("store.keys", { prefix }),
      // One query instead of a get per key; more means the page hit the host's byte budget.
      entries: (prefix: unknown, after: unknown) => call("store.entries", { prefix, after }),
    },
    net: {
      fetch: (url: unknown, init: unknown) => call("net.fetch", { url, init }),
    },
    // Spread: the host reads agent and prompt off the call's own object.
    model: {
      complete: (options: unknown) => call("model.complete", { ...(options as object) }),
      list: (options: unknown) => call("model.list", { ...(options as object) }),
    },
  };
}
