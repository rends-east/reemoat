import { ApiError } from "./http";
import type { MachineId } from "./ids";
import { PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_SETTINGS_FIELD_KINDS } from "./wire";
import type {
  PluginBlock,
  PluginField,
  PluginFieldKind,
  PluginOpen,
  PluginRow,
  PluginRowAction,
  PluginSummary,
  PluginSurface,
  PluginView,
} from "./wire";

// Everything here fails open: an unknown block is dropped, an unknown field kind becomes a text input, and nothing throws.
// DOM-free, so webcheck can import it.

const FIELD_KINDS = ["text", "password", "number", "toggle", "select"] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optional(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowAction(raw: unknown): PluginRowAction {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    id: text(source["id"]),
    label: text(source["label"]),
    // Only the exact word is destructive, so a misspelling fails safe.
    tone: source["tone"] === "destructive" ? "destructive" : "plain",
    confirm: optional(source["confirm"]),
  };
}

const TONES = ["ok", "warn", "danger"] as const;

/** Only the two known shapes, so a URL is never tappable; narrowed here as well as on the daemon. */
function open(raw: unknown): PluginOpen | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as { session?: unknown; screen?: unknown };
  if (typeof source.session === "string" && source.session.length > 0) return { session: source.session };
  return source.screen === true ? { screen: true } : null;
}

function row(raw: unknown): PluginRow {
  const source = (raw ?? {}) as Record<string, unknown>;
  const actions = Array.isArray(source["actions"]) ? source["actions"] : [];
  return {
    id: text(source["id"]),
    title: text(source["title"]),
    subtitle: optional(source["subtitle"]),
    badge: optional(source["badge"]),
    // An unknown tone is no tone: a plugin can fail to warn, never mark something wrong as fine.
    tone: TONES.find((one) => one === source["tone"]) ?? null,
    open: open(source["open"]),
    actions: actions.map(rowAction),
  };
}

function field(raw: unknown, surface: PluginSurface): PluginField {
  const source = (raw ?? {}) as Record<string, unknown>;
  const options = Array.isArray(source["options"]) ? source["options"] : [];
  // Three kinds on a settings pane, five on a screen; narrowed here because a submit's redraw does not tell the daemon which pane it came from.
  const kinds: readonly PluginFieldKind[] = surface === "settings" ? PLUGIN_SETTINGS_FIELD_KINDS : FIELD_KINDS;
  const kind = kinds.find((one) => one === source["kind"]) ?? "text";
  return {
    key: text(source["key"]),
    label: text(source["label"]),
    kind,
    value: typeof source["value"] === "string" ? source["value"] : null,
    options: options.map((entry) => {
      const option = (entry ?? {}) as Record<string, unknown>;
      return { value: text(option["value"]), label: text(option["label"]) };
    }),
    placeholder: optional(source["placeholder"]),
    help: optional(source["help"]),
  };
}

export function readBlock(raw: unknown, surface: PluginSurface = "screen"): PluginBlock | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rows = (value: unknown): PluginRow[] => (Array.isArray(value) ? value.map(row) : []);
  // A block this surface does not draw takes the same exit as an unknown one; the default is screen, the wider set.
  if (surface === "settings" && !PLUGIN_SETTINGS_BLOCK_TYPES.some((one) => one === source["type"])) return null;
  switch (source["type"]) {
    case "text":
      return { type: "text", text: text(source["text"]), tone: source["tone"] === "muted" ? "muted" : "default" };
    case "notice":
      return { type: "notice", text: text(source["text"]), tone: source["tone"] === "danger" ? "danger" : "default" };
    case "list":
      return { type: "list", rows: rows(source["rows"]), empty: text(source["empty"]) };
    case "columns": {
      const columns = Array.isArray(source["columns"]) ? source["columns"] : [];
      return {
        type: "columns",
        columns: columns.map((entry) => {
          const column = (entry ?? {}) as Record<string, unknown>;
          return { title: text(column["title"]), rows: rows(column["rows"]) };
        }),
      };
    }
    case "form": {
      const fields = Array.isArray(source["fields"]) ? source["fields"] : [];
      return {
        type: "form",
        fields: fields.map((one) => field(one, surface)),
        submit: text(source["submit"]) || "Save",
        action: text(source["action"]),
      };
    }
    default:
      return null;
  }
}

export function readView(raw: unknown, surface: PluginSurface = "screen"): PluginView {
  const source = (raw ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(source["blocks"]) ? source["blocks"] : [];
  const refresh = source["refreshMs"];
  return {
    title: optional(source["title"]),
    // Re-clamped: a floor binds only on the side that owns the timer.
    refreshMs: typeof refresh === "number" && Number.isFinite(refresh) && refresh > 0 ? Math.max(MIN_REFRESH_MS, refresh) : null,
    blocks: blocks.map((one) => readBlock(one, surface)).filter((block): block is PluginBlock => block !== null),
  };
}

export const MIN_REFRESH_MS = 2_000;

/** A destination rather than a path, so this module stays DOM-free; the machine is the caller's. */
export function pluginDestination(
  where: PluginOpen | null,
): { kind: "session"; sessionId: string } | { kind: "screen" } | null {
  if (where === null) return null;
  if ("screen" in where) return { kind: "screen" };
  return { kind: "session", sessionId: where.session };
}

/** A null-prototype map: a plugin's key may be __proto__, which on a plain object would crash the render. */
export function seedForm(fields: readonly PluginField[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const one of fields) {
    out[one.key] = one.value ?? (one.kind === "toggle" ? "false" : "");
  }
  return out;
}

/** Compares only the authority installed against what the consent screen showed; null when nothing was gained. */
export function consentBroken(
  shown: { scopes: readonly string[]; net: readonly string[]; hooks: readonly string[]; adds: readonly string[] },
  installed: {
    scopes: readonly string[];
    net: readonly string[];
    contributes: {
      hooks: readonly string[];
      harnesses?: readonly { id: string; command: string; args: readonly string[] }[];
      systems?: readonly { id: string; baseUrl: string | null }[];
    };
  },
): string | null {
  const gained = (theirs: readonly string[], ours: readonly string[]): string[] =>
    [...theirs].filter((one) => !ours.includes(one)).sort();
  const scopes = gained(installed.scopes, shown.scopes);
  const net = gained(installed.net, shown.net);
  const hooks = gained(installed.contributes.hooks, shown.hooks);
  // Absent on an older daemon means none, since it also refuses such manifests; the line is rebuilt as the screen drew it.
  const adds = gained(
    [
      ...(installed.contributes.harnesses ?? []).map(
        (one) => `harness ${one.id} runs ${[one.command, ...one.args].filter((word) => word.length > 0).join(" ")}`,
      ),
      ...(installed.contributes.systems ?? []).map(
        (one) => `system ${one.id} sends keys to ${one.baseUrl ?? "nowhere"}`,
      ),
    ],
    shown.adds,
  );
  if (scopes.length === 0 && net.length === 0 && hooks.length === 0 && adds.length === 0) return null;
  const parts: string[] = [];
  if (scopes.length > 0) parts.push(scopes.join(", "));
  if (net.length > 0) parts.push(`network access to ${net.join(", ")}`);
  if (hooks.length > 0) parts.push(hooks.join(", "));
  if (adds.length > 0) parts.push(adds.join("; "));
  return `That plugin asked for more than this screen showed: ${parts.join("; ")}. Remove it unless you know why.`;
}

/** Thrown on fan-out paths so the row fails, and pluginFailure returns its words verbatim. */
export class ConsentBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentBrokenError";
  }

  static isConsentBroken(error: unknown): error is ConsentBrokenError {
    return error instanceof ConsentBrokenError;
  }
}

/** For daemonFor answering nothing, which means the machine left the list, not that it is unreachable. */
export const MACHINE_GONE = `${machineGone("That machine")}.`;

export function machineGone(subject: string): string {
  return `${subject} is not in your list any more`;
}

function requiredScope(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object") return null;
  const named = (detail as Record<string, unknown>)["required"];
  return typeof named === "string" && named.length > 0 ? named : null;
}

/** Codes map to a sentence naming the remedy; anything unknown falls through to the daemon's message. */
export function pluginFailure(error: unknown): string {
  // Before the ApiError gate: its message names what the plugin gained.
  if (ConsentBrokenError.isConsentBroken(error)) return error.message;
  // Nothing came back, so the machine may have acted: never invite a blind retry of a write.
  if (!(error instanceof ApiError)) {
    return "That machine did not answer, and whether it acted is not known. Check before trying again.";
  }

  // A daemon that predates plugins, recognised by its bare 404 rather than by its version.
  if (error.status === 404 && error.code === `http_${error.status}`) {
    return "This machine's daemon is too old for plugins. Update it and try again.";
  }

  switch (error.code) {
    case "plugins_unavailable":
      return "Plugins are switched off on this machine.";
    case "plugin_not_found":
      return "That plugin is not installed on this machine any more.";
    case "plugin_busy":
      return "This machine is already installing a plugin. Try again in a moment.";
    case "plugin_too_large":
      return "That archive is larger than a plugin may be.";
    case "plugin_unpacked_too_large":
    case "plugin_too_many_entries":
      return "That archive unpacks to more than a plugin may be.";
    case "unsupported_archive":
      return "A plugin has to be a .tar.gz or a .zip.";
    case "archive_empty":
      return "There is nothing in that archive.";
    case "archive_unsafe":
      return "That archive holds a path this machine will not write.";
    case "archive_unreadable":
      return "That archive could not be read.";
    case "manifest_missing":
      return "That archive has no plugin.json at its top level.";
    case "entry_missing":
      return "That plugin has no server.js beside its plugin.json.";
    case "manifest_unreadable":
    case "manifest_invalid":
      return error.message;
    case "plugin_api_too_old":
      return "That plugin is written for an older version of the plugin API.";
    case "plugin_api_too_new":
      return "That plugin needs a newer daemon than this machine is running.";
    case "plugin_start_failed":
      return `That plugin would not start, so nothing was changed. ${error.message}`;
    case "plugin_consent_broken":
      return `That commit asks for more than this screen showed you, so nothing was installed. ${error.message}`;
    case "plugin_source_not_found":
      return "That plugin's code is not where the catalogue says it is. It may have been withdrawn.";
    case "plugin_source_unavailable":
      return "This machine could not fetch that plugin from GitHub. Try again in a moment.";
    case "plugin_source_invalid":
      return error.message;
    case "plugin_timeout":
      return "That plugin did not answer in time.";
    case "plugin_unavailable":
      return "That plugin is not running.";
    case "plugin_overloaded":
      return "That plugin is answering as much as it can. Try again in a moment.";
    case "plugin_request_too_large":
      return "That was more than this plugin can be sent in one go.";
    case "plugin_scope_denied":
      return "That plugin asked for something it did not declare, and was refused.";
    // Read off required, so the sentence names the permission that would actually work.
    case "insufficient_scope": {
      const required = requiredScope(error.detail);
      if (required === "machine:admin") return "Installing and removing plugins needs admin access to this machine.";
      if (required !== null) return `That needs the ${required} scope, which this access does not carry.`;
      return "You do not have access to do that on this machine.";
    }
    default:
      return error.message;
  }
}

/** Both halves: a switched-off plugin must not draw an empty board. */
export function pluginUsable(plugin: PluginSummary): boolean {
  return plugin.enabled && plugin.state !== "failed";
}

export function pluginStateText(plugin: PluginSummary): string {
  if (!plugin.enabled) return "Switched off";
  switch (plugin.state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export function screenPlugins(plugins: readonly PluginSummary[]): PluginSummary[] {
  return plugins.filter((plugin) => plugin.contributes.screen !== null && pluginUsable(plugin));
}

export interface PluginActionOffer {
  plugin: PluginSummary;
  actionId: string;
  title: string;
}

/**
 * Superseded as a gate (Q3.468): the live one, settingsBlockFor, needs every machine, while this means anywhere (Q7.108).
 * Kept because pane.ts relies on the anywhere rule; enabled is deliberately not consulted.
 */
export function offersSettings(plugins: readonly PluginSummary[], pluginId: string): boolean {
  return plugins.some((one) => one.id === pluginId && one.contributes.settings);
}

/** Only session actions, only from a usable plugin, in declaration order. */
export function sessionActions(plugins: readonly PluginSummary[]): PluginActionOffer[] {
  const offers: PluginActionOffer[] = [];
  for (const plugin of plugins) {
    if (!pluginUsable(plugin)) continue;
    for (const action of plugin.contributes.actions) {
      if (action.on !== "session") continue;
      offers.push({ plugin, actionId: action.id, title: action.title });
    }
  }
  return offers;
}

/** Short and outside settings: a plugin's screen is opened daily, its settings rarely (Q3.468). */
export function pluginPath(machineId: MachineId, pluginId: string): string {
  return `/p/${encodeURIComponent(machineId)}/${encodeURIComponent(pluginId)}`;
}
