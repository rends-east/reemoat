import { ApiError } from "./http";
import type { MachineId } from "./ids";
import type { PluginBlock, PluginField, PluginOpen, PluginRow, PluginRowAction, PluginSummary, PluginView } from "./wire";

/**
 * What a plugin is allowed to make this client draw, and what happens when it
 * sends something this client has never heard of.
 *
 * **Everything here fails open.** That is rule 2 of `.claude/rules/compatibility.md`
 * applied to a second wire: the web client ships inside the control plane's image
 * and a daemon updates when its owner runs `deploy.sh`, so *new client against old
 * daemon* is the normal state of the fleet — and a plugin is a third schedule
 * again, written by somebody neither of those releases coordinates with. A
 * narrowing that threw would take a whole screen away because one row carried a
 * field it did not recognise.
 *
 * The failure this posture exists to prevent is on record: `endedWithDaemon` asked
 * "is this a daemon reason?" and answered *no* for a reason it had never heard of,
 * which dropped the session into `showsAsEnded` and took the composer off screen
 * for a conversation that was coming back. So: an unknown block is dropped, an
 * unknown field kind becomes a text input, a missing string becomes an empty one,
 * and nothing anywhere throws.
 *
 * DOM-free on purpose, like `settings.ts` and `groups.ts`, so `webcheck` can
 * import it — a decision the driver cannot reach is a decision nothing asserts.
 */

const FIELD_KINDS = ["text", "password", "number", "toggle", "select"] as const;

/** A string, or the empty string. Never `undefined` reaching a `className`. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A string, or `null`. The distinction is drawn: a subtitle that is absent is not one that is empty. */
function optional(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowAction(raw: unknown): PluginRowAction {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    id: text(source["id"]),
    label: text(source["label"]),
    // Anything that is not the one word we act differently on is the ordinary
    // tone. A plugin cannot make a button look harmless by misspelling
    // "destructive"; it can only fail to make one look dangerous, which is the
    // safe direction for this particular guess to be wrong in.
    tone: source["tone"] === "destructive" ? "destructive" : "plain",
    confirm: optional(source["confirm"]),
  };
}

const TONES = ["ok", "warn", "danger"] as const;

/**
 * Where a row goes, or `null`.
 *
 * ⚠ **The two known shapes and nothing else.** This is the field a plugin would
 * most like to put a URL in, and `{url: …}` lands here as `null` — a row that is
 * simply not tappable. The daemon narrows it too; this is the second of the two,
 * because `wire.ts` is a hand mirror and a client that trusted the daemon's
 * narrowing would be trusting a copy.
 */
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
    // An unrecognised tone is no tone: a plugin can fail to mark something as
    // wrong and cannot mark something wrong as fine.
    tone: TONES.find((one) => one === source["tone"]) ?? null,
    open: open(source["open"]),
    actions: actions.map(rowAction),
  };
}

function field(raw: unknown): PluginField {
  const source = (raw ?? {}) as Record<string, unknown>;
  const options = Array.isArray(source["options"]) ? source["options"] : [];
  const kind = FIELD_KINDS.find((one) => one === source["kind"]) ?? "text";
  return {
    key: text(source["key"]),
    label: text(source["label"]),
    // An unknown kind draws a text input rather than nothing. The value still
    // round-trips, so a field this client is too old to draw properly is still a
    // field somebody can read and submit — which is the whole of failing open.
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

/** One block, or `null` when this client cannot draw it. */
export function readBlock(raw: unknown): PluginBlock | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rows = (value: unknown): PluginRow[] => (Array.isArray(value) ? value.map(row) : []);
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
        fields: fields.map(field),
        submit: text(source["submit"]) || "Save",
        action: text(source["action"]),
      };
    }
    default:
      // Dropped, never drawn as a placeholder. A block from a plugin written
      // against a newer client is something this one has no honest way to show,
      // and an "unsupported block" row on every screen would be worse than the
      // screen simply being shorter.
      return null;
  }
}

export function readView(raw: unknown): PluginView {
  const source = (raw ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(source["blocks"]) ? source["blocks"] : [];
  const refresh = source["refreshMs"];
  return {
    title: optional(source["title"]),
    /*
     * Re-clamped here, and not because the daemon's clamp is doubted.
     * `PLUGIN_REFRESH_MIN_MS` is a *daemon* constant, and an old daemon whose
     * floor was lower — or a field this client is reading from a build that
     * predates the clamp — would otherwise set a timer this tab has to honour.
     * A floor on the side that owns the timer is the only one that binds.
     */
    refreshMs: typeof refresh === "number" && Number.isFinite(refresh) && refresh > 0 ? Math.max(MIN_REFRESH_MS, refresh) : null,
    blocks: blocks.map(readBlock).filter((block): block is PluginBlock => block !== null),
  };
}

/** The fastest this client will re-read a plugin's view, whatever it asked for. */
export const MIN_REFRESH_MS = 2_000;

/**
 * A destination, resolved against the machine the plugin is on.
 *
 * Returns what to navigate to rather than a path, so this module stays DOM-free
 * and the path builders stay in one place each — `sessionPath` in `router.ts` and
 * `pluginPath` below. A second copy of either would be a second thing to get
 * wrong about encoding.
 */
export function pluginDestination(
  machineId: MachineId,
  where: PluginOpen | null,
): { kind: "session"; sessionId: string } | { kind: "screen" } | null {
  if (where === null) return null;
  if ("screen" in where) return { kind: "screen" };
  void machineId;
  return { kind: "session", sessionId: where.session };
}

/**
 * The form's own state, seeded from what the plugin sent.
 *
 * Separate from the field list because a form is edited and a view is redrawn:
 * the screen holds this and hands it back on submit, so a plugin does not have to
 * re-derive what somebody typed from a view it has not been sent yet.
 */
export function seedForm(fields: readonly PluginField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const one of fields) {
    // A toggle whose value the plugin left unset reads as off. Every field is a
    // string on the wire, including a toggle, so there is one narrowing here and
    // not five — see `PluginField.value`.
    out[one.key] = one.value ?? (one.kind === "toggle" ? "false" : "");
  }
  return out;
}

/**
 * A refusal from a plugin route, as a sentence.
 *
 * The shape `importFailure` established one screen over, and for its reasons: the
 * codes are a closed set this client knows, the sentence names the *remedy* rather
 * than restating the failure, and anything unrecognised falls through to the
 * message the daemon sent rather than to "something went wrong".
 */
export function pluginFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return "That did not work. Try again.";

  /*
   * A daemon that predates plugins, recognised by the **shape of its refusal**
   * rather than by its version.
   *
   * `parseBody` turns Hono's bare 404 — no envelope, so no code of this system's
   * own — into `code === "http_404"`, and that is the whole test. Branching on
   * `DAEMON_VERSION` is what compatibility rule 1 forbids: the version is a label,
   * announced and read by nothing, and the moment a client behaves differently for
   * 0.2.0 than for 0.3.0 every daemon in the fleet is back in lockstep with the
   * weekly control-plane deploy. `importSupported()` is the same test one screen
   * over.
   */
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
      // The daemon's own sentence names the field, which is the only useful thing
      // to say to whoever is holding the manifest.
      return error.message;
    case "plugin_api_too_old":
      return "That plugin is written for an older version of the plugin API.";
    case "plugin_api_too_new":
      return "That plugin needs a newer daemon than this machine is running.";
    case "plugin_start_failed":
      return `That plugin would not start, so nothing was changed. ${error.message}`;
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
    case "insufficient_scope":
      return "You have read-only access to this machine.";
    default:
      return error.message;
  }
}

/**
 * Whether a plugin is drawing anything right now.
 *
 * Both halves, because they fail differently and a screen that asks only one of
 * them draws an empty board for a plugin somebody switched off.
 */
export function pluginUsable(plugin: PluginSummary): boolean {
  return plugin.enabled && plugin.state !== "failed";
}

/** What a plugin's row says about its state, in words rather than in a colour. */
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
      // Enabled and not running is a plugin between states — it has not been asked
      // for anything yet. "Idle" rather than "Stopped", which would read as an
      // instruction to do something about it.
      return "Idle";
  }
}

/** Which plugins offer a screen on this machine, in the order they are drawn. */
export function screenPlugins(plugins: readonly PluginSummary[]): PluginSummary[] {
  return plugins.filter((plugin) => plugin.contributes.screen !== null && pluginUsable(plugin));
}

/** One action a plugin offers on a session's menu, with the plugin that offers it. */
export interface PluginActionOffer {
  plugin: PluginSummary;
  actionId: string;
  title: string;
}

/**
 * Which plugin actions belong on a session's menu.
 *
 * Flattened here rather than in the menu, so the two rules are in one place and
 * `webcheck` can hold them: only `on: "session"` actions — a `screen` action is
 * offered on the plugin's own screen and nowhere else — and only from a plugin
 * that is drawing at all, because a row that answers "that plugin is not running"
 * is worse than no row. Declaration order is kept: it is the order the plugin's
 * author wrote, and the menu has nothing better to sort by.
 */
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

/**
 * `/p/:machineId/:pluginId`, and the reason it is not under `/settings`.
 *
 * A plugin's *settings* live inside its machine, beside that machine's agents,
 * because they are configuration of one daemon. A plugin's **screen** is not
 * configuration — it is a thing somebody opens to look at, several times a day,
 * from a phone — and four taps into a settings sheet is not where that belongs.
 * Short, because it is typed and shared.
 */
export function pluginPath(machineId: MachineId, pluginId: string): string {
  return `/p/${encodeURIComponent(machineId)}/${encodeURIComponent(pluginId)}`;
}
