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

function field(raw: unknown, surface: PluginSurface): PluginField {
  const source = (raw ?? {}) as Record<string, unknown>;
  const options = Array.isArray(source["options"]) ? source["options"] : [];
  /*
   * ⚠ **Three kinds on a settings pane, five on a screen**, and the narrowing is
   * here as well as in the daemon because this is the side that knows. The daemon
   * clamps the *view* it answers with, which is enough for a read — but a form's
   * submit can answer with a redrawn pane, and it reaches the daemon as an action
   * id that says nothing about which pane it came from. This component is drawing
   * one, so it decides.
   *
   * Fail-open either way: an unsupported kind is a text box that still
   * round-trips, never a dropped control. `password` narrowing to a visible box
   * is the one that looks like a regression and is not — the value is kept in a
   * plaintext column on the daemon, so the mask was an assurance nothing here can
   * keep.
   */
  const kinds: readonly PluginFieldKind[] = surface === "settings" ? PLUGIN_SETTINGS_FIELD_KINDS : FIELD_KINDS;
  const kind = kinds.find((one) => one === source["kind"]) ?? "text";
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

/** One block, or `null` when this surface does not draw it. */
export function readBlock(raw: unknown, surface: PluginSurface = "screen"): PluginBlock | null {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rows = (value: unknown): PluginRow[] => (Array.isArray(value) ? value.map(row) : []);
  /*
   * ⚠ **A block this *surface* does not draw takes the same exit as a block this
   * *client* does not know**, which is `null` and a shorter screen. One exit
   * rather than two: a settings pane refusing a `list` and an old tab refusing a
   * block from a newer daemon are the same event as far as this function's caller
   * is concerned, and giving them separate paths is how one of them grows a
   * placeholder row the other does not have.
   *
   * ⚠ **Defaulted to `screen`, the wider set.** A call site that has not been
   * told which surface it is on keeps today's behaviour rather than silently
   * deleting somebody's controls.
   */
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
      // Dropped, never drawn as a placeholder. A block from a plugin written
      // against a newer client is something this one has no honest way to show,
      // and an "unsupported block" row on every screen would be worse than the
      // screen simply being shorter.
      return null;
  }
}

export function readView(raw: unknown, surface: PluginSurface = "screen"): PluginView {
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
    blocks: blocks.map((one) => readBlock(one, surface)).filter((block): block is PluginBlock => block !== null),
  };
}

/** The fastest this client will re-read a plugin's view, whatever it asked for. */
export const MIN_REFRESH_MS = 2_000;

/**
 * Where a row's `open` goes, as a destination rather than as a path.
 *
 * Returns what to navigate to rather than a path, so this module stays DOM-free
 * and the path builders stay in one place each — `sessionPath` in `router.ts` and
 * `pluginPath` below. A second copy of either would be a second thing to get
 * wrong about encoding.
 *
 * ⚠ **The machine is the caller's, and deliberately not an argument here.** A
 * plugin runs on one daemon and every destination it names is on that daemon, so
 * the id would be a parameter this function could only pass back out — which it
 * was, ignored behind a `void`, reading to the next person as if it did work.
 */
export function pluginDestination(
  where: PluginOpen | null,
): { kind: "session"; sessionId: string } | { kind: "screen" } | null {
  if (where === null) return null;
  if ("screen" in where) return { kind: "screen" };
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
 * What the machine says it installed, against what somebody was shown — and the
 * words for the difference, or `null` when there is none.
 *
 * ⚠ **The belt on the whole consent screen, and it exists because that screen has
 * now been wrong four separate ways.** `pluginArchive.ts` re-implements enough of
 * tar and zip to name the member the daemon will pick, and every time the two
 * spellings diverged the result was the same: a manifest declaring nothing drawn
 * under the plain "Install it" button while the machine installed one holding
 * every scope plus `permission.requested`. Each of the four was fixed in the
 * reader and pinned in `webcheck`; this is the half that does not depend on
 * having thought of the fifth.
 *
 * It compares only what the reader claims to know and the daemon actually
 * returns — the authority a plugin gets. Names and versions are deliberately not
 * compared: a manifest is free to say what it likes about itself, and the
 * question here is not "is this the file I picked" but "is this what I agreed
 * to give it".
 */
export function consentBroken(
  shown: { scopes: readonly string[]; net: readonly string[]; hooks: readonly string[] },
  installed: { scopes: readonly string[]; net: readonly string[]; contributes: { hooks: readonly string[] } },
): string | null {
  const gained = (theirs: readonly string[], ours: readonly string[]): string[] =>
    [...theirs].filter((one) => !ours.includes(one)).sort();
  // Only what it *gained*. A plugin that ends up with less than the screen showed
  // is not a broken consent — it is a manifest this reader read generously, which
  // costs nobody anything.
  const scopes = gained(installed.scopes, shown.scopes);
  const net = gained(installed.net, shown.net);
  const hooks = gained(installed.contributes.hooks, shown.hooks);
  if (scopes.length === 0 && net.length === 0 && hooks.length === 0) return null;
  const parts: string[] = [];
  if (scopes.length > 0) parts.push(scopes.join(", "));
  if (net.length > 0) parts.push(`network access to ${net.join(", ")}`);
  if (hooks.length > 0) parts.push(hooks.join(", "));
  return `That plugin asked for more than this screen showed: ${parts.join("; ")}. Remove it unless you know why.`;
}

/**
 * A broken consent, as something that can be thrown without losing its words.
 *
 * ⚠ **The one sentence on this whole screen that must never be replaced, and it
 * was being replaced.** {@link consentBroken} is raised on the fan-out paths by
 * throwing — which is right, because a thrown act lands the row on `failed` and
 * leaves the box unticked, and a ticked box for a plugin this screen has just
 * refused to trust is the one lie the consent step exists to prevent. But a plain
 * `Error` is not an `ApiError`, so {@link pluginFailure} answered **"That did not
 * work. Try again."** — deleting the naming of which scope was gained and
 * inviting the person to install it a second time. The single-machine path in
 * `PluginsPanel` does `toast("error", broken)` and shows it verbatim, so the same
 * check was disclosed in one flow and discarded in the other.
 *
 * A class with a static guard rather than a bare `instanceof`, for
 * `ApiError.isApiError`'s reason one module over.
 */
export class ConsentBrokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentBrokenError";
  }

  static isConsentBroken(error: unknown): error is ConsentBrokenError {
    return error instanceof ConsentBrokenError;
  }
}

/** Which scope a `403 insufficient_scope` said it wanted, or `null` if it did not say. */
function requiredScope(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object") return null;
  const named = (detail as Record<string, unknown>)["required"];
  return typeof named === "string" && named.length > 0 ? named : null;
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
  /*
   * ⚠ **Before the `ApiError` gate, because this one is ours rather than a
   * daemon's.** See {@link ConsentBrokenError}: it carries the only sentence here
   * that names what a plugin gained, and the generic arm below would replace it
   * with an invitation to try the install again.
   */
  if (ConsentBrokenError.isConsentBroken(error)) return error.message;
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
    /*
     * ⚠ **The one refusal on the market path that is about *authority* rather
     * than about machinery, so it says what to do about it.** The daemon parsed
     * the manifest at the pinned commit and found it asking for more than the
     * disclosure screen showed — and refused before starting the plugin, so
     * nothing ran. The daemon's own sentence names which scope, host or hook was
     * gained, which is the only useful thing to say, so it is carried through
     * rather than replaced.
     */
    case "plugin_consent_broken":
      return `That commit asks for more than this screen showed you, so nothing was installed. ${error.message}`;
    /*
     * A daemon too old to fetch a plugin for itself, recognised by the shape of
     * its refusal exactly as a daemon with no plugins at all is: `POST
     * /plugins/source` is a route it has never registered, so Hono answers a bare
     * 404 and `parseBody` makes it `http_404`. The 404 arm at the top of this
     * function catches that first and says "update it" — this arm is the
     * *catalogue's* 404, which is a different fact with a different remedy.
     */
    case "plugin_source_not_found":
      return "That plugin's code is not where the catalogue says it is. It may have been withdrawn.";
    case "plugin_source_unavailable":
      return "This machine could not fetch that plugin from GitHub. Try again in a moment.";
    case "plugin_source_invalid":
      // The daemon names which of the two fields, and whether it was a tag where a
      // commit belongs — which is the one somebody can act on.
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
    /*
     * ⚠ **Read off `required`, because four of these seven routes want
     * `machine:admin` rather than `session:write`.** Both installs — the upload
     * and the one from a commit — remove and the
     * state switch are the admin ones, so a grant that really does hold
     * `session:write` was being told it was read-only — a sentence naming the
     * wrong permission is worse than one naming none, since the remedy it points
     * at is not the one that would work. The daemon already sends which scope it
     * wanted; `requireScope` puts it in the envelope's detail.
     */
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
 * Whether this plugin offers settings anywhere in the fleet.
 *
 * ⚠ **Nothing draws a control from this any more, and it is kept for its two
 * rules rather than for its answer.** It gated the **gear**, which is gone
 * (Q3.468): the gear was the only route in and it asked no question about *which*
 * machines — the screen it opened picked one from a dropdown over
 * `installs.filter(contributes.settings)`, a set that is not the set the plugin is
 * on, and where that came to one it drew no control at all. The route now is the
 * machine table's **bulk bar**, over the machines somebody ticked, and the scope
 * rides the URL rather than a picker. So the live gate is `bulkEnabled`'s
 * `settings` arm over `settingsBlockFor` in `install.ts`, per machine and per
 * *reason*.
 *
 * ⚠ **Which means its headline rule is the opposite of the shipped one, and that
 * is the trap this docblock exists to disarm.** *Anywhere* was right for a control
 * that opened a screen picking one machine out of a set. Settings is a
 * **navigation** now — one screen, nothing to skip — so it is enabled only where
 * *every* selected machine can take it, or a selection of seven opens a screen
 * about a subset. Wiring this predicate back into that control would re-open
 * Q7.108 exactly as it was written.
 *
 * ⚠ **`enabled` is not consulted**, and *that* half survives the move intact —
 * `settingsBlockFor` does not consult it either. A plugin somebody switched off is
 * the commonest reason to open its settings, to fix whatever made them switch it
 * off, and a control that disappears when a thing stops working is a control they
 * go looking for. The pane itself reports whatever the daemon says about a stopped
 * plugin.
 *
 * ⚠ **And *anywhere, not everywhere* is still live one module over**, which is why
 * this is not simply deleted: `pane.ts` cites it by name for the machine whose
 * version has no `settings` at all — excluded rather than `divergent`, because a
 * fleet mid-update is the ordinary case and calling it a disagreement would refuse
 * the whole screen over a host with nothing to say.
 *
 * Takes a flat list rather than the store's map, so this stays a pure decision
 * `webcheck` can sweep. The caller flattens — when there is one.
 */
export function offersSettings(plugins: readonly PluginSummary[], pluginId: string): boolean {
  return plugins.some((one) => one.id === pluginId && one.contributes.settings);
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
 * ⚠ **A plugin's *settings* are not inside one machine either any more** —
 * Q3.468 moved them out to a screen of their own, scoped to the machines somebody
 * ticked on the machine table and carrying that scope in the URL
 * (`marketSettingsPath`). What survives is the distinction this path exists for,
 * and it was never about *which* screen settings sat on: settings are
 * configuration, answered once and then left alone. A plugin's **screen** is not —
 * it is a thing somebody opens to look at, several times a day, from a phone — and
 * however few taps the settings route now costs, that is not where a thing you
 * open daily belongs. Short, because it is typed and shared.
 */
export function pluginPath(machineId: MachineId, pluginId: string): string {
  return `/p/${encodeURIComponent(machineId)}/${encodeURIComponent(pluginId)}`;
}
