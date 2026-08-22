/**
 * What a plugin and this daemon agree on, and what the browser is then shown.
 *
 * **Everything here is copied by hand into `packages/web/src/wire.ts`**, exactly
 * as the session event union is, so nothing in this file may import anything —
 * not `node:`, not a sibling. A single import is what makes a file unmirrorable,
 * and the mirror is what lets the web client narrow these shapes without pulling
 * the daemon's dependency tree into a browser bundle.
 *
 * Two vocabularies live here and they are not the same thing:
 *
 *   - the **manifest**, which is what a plugin author writes down and this daemon
 *     validates once, at install;
 *   - the **view**, which is what a plugin returns every time somebody looks at
 *     one of its screens.
 *
 * The IPC vocabulary — how the host and the child actually talk — is deliberately
 * *not* here: it never reaches a browser, so mirroring it would be inviting
 * somebody to reason about a shape they can never receive. That lives in
 * `runtime.ts`.
 */

/**
 * The newest plugin API this daemon speaks, and the oldest it still accepts.
 *
 * **A range, negotiated — never a label.** This is `RELAY_PROTOCOL_VERSION` /
 * `RELAY_PROTOCOL_MIN_VERSION` one directory over, and it is the same shape for
 * the same reason (`.claude/rules/compatibility.md`, rule 1): a plugin written
 * against api 1 must keep working on a daemon that has learnt api 2, or every
 * plugin in the world has to be republished in lockstep with a daemon release
 * nobody controls the timing of.
 *
 * ⚠ **`DAEMON_VERSION` is not consulted anywhere in this subsystem**, and a
 * plugin may not branch on it either. Capability is this number; the version is a
 * label that is reported and never read.
 *
 * `MIN` moves only when there is nothing left below it, and there is no inventory
 * of installed plugins to consult — so in practice it moves approximately never.
 * Raising it is what breaks somebody's Tuesday.
 *
 * **v2 added `open`, `refreshMs` and `tone`, and the ceiling moved while the floor
 * did not.** That is the accept-both step `compatibility.md` writes down: a plugin
 * declaring `1` keeps working here untouched, and a plugin that *needs* the new
 * fields declares `2` and gets `plugin_api_too_new` from an older daemon rather
 * than silently losing its navigation. Which of the two a plugin is is the
 * author's decision, and the number is how they say it.
 */
export const PLUGIN_API_VERSION = 2;

/** The oldest `api` an install still accepts. See {@link PLUGIN_API_VERSION}. */
export const PLUGIN_API_MIN_VERSION = 1;

/** Why a manifest's `api` is not one this daemon can run. */
export type PluginApiVerdict = "ok" | "too_old" | "too_new";

/**
 * Whether this daemon can run a plugin declaring this api.
 *
 * Three answers rather than a boolean, because the two refusals need opposite
 * sentences: *too old* means the plugin has to be republished, and *too new*
 * means the machine has to be updated. One "unsupported" would send everybody to
 * the wrong place half the time.
 */
export function negotiatePluginApi(declared: number): PluginApiVerdict {
  if (declared < PLUGIN_API_MIN_VERSION) return "too_old";
  if (declared > PLUGIN_API_VERSION) return "too_new";
  return "ok";
}

/**
 * What a plugin may ask this daemon to do on its behalf.
 *
 * ⚠ **These are not token scopes and the two must never be conflated.**
 * `session:read`/`session:write`/`machine:admin` in `src/auth.ts` decide what the
 * *caller of a route* may do. These decide what the *plugin* may do — including
 * inside a hook, where there is no caller at all. A read-only grant cannot invoke
 * a plugin action; a plugin without `sessions.write` cannot send a prompt. Both
 * hold at once and neither implies the other.
 *
 * ⚠ **This is hygiene, not a fence.** The plugin is a child process running as
 * this uid: it can `import("node:fs")` and read everything the daemon can. What
 * declaring a scope buys is that the blast radius is *named*, shown to whoever
 * installs it, and refused when the plugin steps outside what it claimed — which
 * catches the mistake rather than the attacker. `SECURITY.md` says so in those
 * words, and this comment exists so nobody restores the stronger claim.
 */
export type PluginScope = "sessions.read" | "sessions.write" | "files.read" | "store" | "net";

export const PLUGIN_SCOPES: readonly PluginScope[] = [
  "sessions.read",
  "sessions.write",
  "files.read",
  "store",
  "net",
];

/*
 * ⚠ **The sentence each of these is shown as lives in `packages/web/src/wire.ts`,
 * and there is deliberately no copy here.** There was one — exhaustive, so a sixth
 * scope would not compile without a sentence — and it was referenced by nothing:
 * the table that is actually drawn is the mirror, so the compiler was guarding the
 * copy nobody reads while a new scope would have fallen through to a raw
 * identifier on the copy somebody sees. An unread table that type-checks is worse
 * than no table, because it answers the question "is this covered?" with a yes.
 * The daemon shows a scope list and never a sentence; whoever adds a scope to the
 * union above writes its sentence where it is rendered.
 */

/**
 * The events a plugin may be told about.
 *
 * A closed union, and small on purpose: every member is a *summary* the host
 * derives, never a `StoredEvent` handed through. What a plugin receives has to be
 * something this daemon is willing to keep sending, and the session event union
 * is a wire the agents move — coupling a plugin to it would make every ACP change
 * somebody else's breaking change.
 */
export type PluginHook =
  | "session.created"
  | "turn.ended"
  | "session.ended"
  | "permission.requested"
  | "permission.resolved";

export const PLUGIN_HOOKS: readonly PluginHook[] = [
  "session.created",
  "turn.ended",
  "session.ended",
  "permission.requested",
  // The other half of `requested`, and it arrived because the pair was
  // asymmetric: a plugin could learn that a question had been *asked* and never
  // how it ended, which makes "how often do I approve this" — the obvious first
  // thing anybody would build on `requested` — unanswerable.
  "permission.resolved",
];

/** Where an action is offered. `session` is the session menu; `screen` is the plugin's own. */
export type PluginActionSurface = "session" | "screen";

export interface PluginAction {
  id: string;
  title: string;
  on: PluginActionSurface;
}

/**
 * The four places a plugin may appear, and there are no others.
 *
 * Closed deliberately. The web client is shaped around one question — *does
 * anything anywhere need me* — and the signals that answer it are computed by
 * subtraction (`waitingFloor`), so a contribution point able to insert rows into
 * the session list would open a hole in a property nothing else can see. A
 * transcript card and a slash command are both recorded non-goals with their
 * seams named rather than half-built here.
 */
export interface PluginContributions {
  /** A full screen, reached at `/p/:machineId/:pluginId`. `null` for no screen. */
  screen: { title: string } | null;
  /** Whether the plugin draws a settings pane of its own. */
  settings: boolean;
  actions: readonly PluginAction[];
  hooks: readonly PluginHook[];
}

/** A plugin's `plugin.json`, after validation. Never the raw parse. */
export interface PluginManifest {
  /**
   * Lower-case, and that is a containment decision rather than a style one: this
   * string becomes a directory name and a URL segment, and on a case-insensitive
   * filesystem `Board` and `board` are one directory holding two plugins.
   */
  id: string;
  name: string;
  version: string;
  api: number;
  description: string | null;
  scopes: readonly PluginScope[];
  /** Hosts `net.fetch` may reach. Empty unless `scopes` holds `net`. */
  net: readonly string[];
  contributes: PluginContributions;
}

/* ── What a plugin draws ─────────────────────────────────────────────────── */

export type PluginRowActionTone = "plain" | "destructive";

export interface PluginRowAction {
  id: string;
  label: string;
  tone: PluginRowActionTone;
  /** A question to ask first, in the two-step shape settings rows already use. `null` for none. */
  confirm: string | null;
}

/**
 * What a row is *saying*, rather than what colour it is.
 *
 * The answer to every request for CSS so far, and the shape is deliberate: a
 * plugin names the meaning and the **host picks the ink**. So a plugin cannot
 * spend the one heavy fill this palette has, cannot put a value below the
 * contrast floor `edge-strong` holds, and cannot be wrong about it on a phone in
 * sunlight — while still being able to say "this one is broken".
 *
 * `PluginRowAction.tone` was already this shape one field over. This is the same
 * decision applied to the row.
 */
export type PluginRowTone = "ok" | "warn" | "danger";

/**
 * Where a row takes you, or `null`.
 *
 * ⚠ **A destination this app already has, never a URL.** A plugin names a session
 * on this machine or its own screen; it cannot name an address. Two reasons, and
 * the second is the one that closes the question: an external link chosen by a
 * plugin is a phishing surface on the page that approves shell commands — and
 * "a plugin deciding where somebody goes" is exactly what was refused for a
 * session-menu action, so allowing it here would make that refusal arbitrary.
 *
 * What is allowed is a *pointer into what the plugin can already read*: if it
 * holds `sessions.read` it knows those ids, and opening one is what a board is
 * for.
 */
export type PluginOpen = { session: string } | { screen: true };

export interface PluginRow {
  id: string;
  title: string;
  subtitle: string | null;
  badge: string | null;
  tone: PluginRowTone | null;
  /** Tapping the row goes here. Its actions still take precedence over it. */
  open: PluginOpen | null;
  actions: readonly PluginRowAction[];
}

export type PluginFieldKind = "text" | "password" | "number" | "toggle" | "select";

export interface PluginFieldOption {
  value: string;
  label: string;
}

export interface PluginField {
  key: string;
  label: string;
  kind: PluginFieldKind;
  /** Always a string on the wire, `"true"`/`"false"` for a toggle. One narrowing, not five. */
  value: string | null;
  options: readonly PluginFieldOption[];
  placeholder: string | null;
  help: string | null;
}

/**
 * The whole drawing vocabulary, and it is five members.
 *
 * **A plugin sends a description, never markup and never code.** That is the one
 * real security boundary this subsystem has: the origin holding
 * `reemoat.credential` executes nothing a plugin author wrote, so there is no
 * CSP to widen, no sandboxed frame to get right, and no bridge protocol to
 * version. Everything else here — the child process, the scope table, the
 * stripped environment — is hygiene by comparison.
 *
 * Small on purpose. Five blocks render with primitives `bits.tsx` already has, so
 * a plugin screen is consistent with the rest of the app and legible on a phone
 * without its author thinking about either.
 */
export type PluginBlock =
  | { type: "text"; text: string; tone: "default" | "muted" }
  | { type: "notice"; text: string; tone: "default" | "danger" }
  | { type: "list"; rows: readonly PluginRow[]; empty: string }
  | { type: "columns"; columns: readonly { title: string; rows: readonly PluginRow[] }[] }
  | { type: "form"; fields: readonly PluginField[]; submit: string; action: string };

export interface PluginView {
  title: string | null;
  /**
   * How often this view asks to be re-read, or `null` for never.
   *
   * **Declared by the plugin, clamped by the host, and spent only while somebody
   * is looking.** A plugin screen used to be a photograph: read once when it was
   * opened, and stale from the next turn onward — which for a board whose whole
   * job is watching agents work is the wrong medium entirely.
   *
   * It is not a subscription and deliberately not one. A push would mean the
   * daemon holding a per-plugin channel open to every tab; this is a `GET` the
   * client already knows how to make, on a screen that is on the screen. The
   * client stops it when the sheet closes or the tab goes to the background, so
   * a plugin cannot buy background work by asking for a small number.
   */
  refreshMs: number | null;
  blocks: readonly PluginBlock[];
}

/**
 * What an invocation answers with.
 *
 * Two members. An action either redraws the screen it was pressed on, or says one
 * sentence — and a session-menu action can only do the second, because there is
 * no screen under it to redraw. Opening the plugin's screen from a session action
 * is deliberately not a third member: it is a navigation a plugin would be
 * choosing on somebody's behalf, and this app has no control anywhere that does
 * that.
 */
export type PluginResult =
  | { kind: "view"; view: PluginView }
  | { kind: "toast"; text: string; tone: "default" | "danger" };

/* ── Bounds ──────────────────────────────────────────────────────────────── */

/**
 * How much of a view this daemon will forward.
 *
 * A plugin is a child process that can return anything, and the thing on the
 * other end is a phone holding 16 MiB for a whole conversation. Clamped here
 * rather than refused, because a board with 300 cards is somebody's real board
 * and answering `500` to it is worse than drawing 200 of them — but clamped
 * *visibly*, which is what `clampView` reports so the screen can say a list was
 * cut rather than quietly showing a wrong number.
 */
/**
 * How often a view may ask to be re-read.
 *
 * A floor because the number is the plugin's to choose and a request rate is a
 * cost somebody else pays — two seconds is faster than a person can read a board
 * and slower than a poll worth arguing about. A ceiling because a value past it
 * is indistinguishable from `null` and saying so is cheaper than a plugin author
 * wondering why nothing happened.
 */
export const PLUGIN_REFRESH_MIN_MS = 2_000;
export const PLUGIN_REFRESH_MAX_MS = 300_000;

export const PLUGIN_VIEW_LIMITS = {
  blocks: 24,
  rows: 200,
  columns: 8,
  fields: 40,
  options: 40,
  actionsPerRow: 4,
  text: 4_000,
  short: 200,
} as const;

/** What a clamp did, so a caller can say so rather than hide it. */
export interface ClampedView {
  view: PluginView;
  /** True when anything at all was cut. Drawn as a line, never swallowed. */
  clamped: boolean;
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * A view, cut to what this daemon will forward.
 *
 * Pure and total: every branch produces *something*, because the alternative is a
 * plugin whose one bad row makes its whole screen unreachable. Anything
 * unrecognised is dropped rather than thrown on — the same posture the web
 * client's own narrowing takes at the other end, and for the same reason.
 */
export function clampView(raw: unknown): ClampedView {
  let clamped = false;
  const source = (raw ?? {}) as { title?: unknown; blocks?: unknown; refreshMs?: unknown };
  const rawBlocks = Array.isArray(source.blocks) ? source.blocks : [];
  if (rawBlocks.length > PLUGIN_VIEW_LIMITS.blocks) clamped = true;

  const blocks: PluginBlock[] = [];
  for (const entry of rawBlocks.slice(0, PLUGIN_VIEW_LIMITS.blocks)) {
    const block = entry as { type?: unknown };
    switch (block.type) {
      case "text":
      case "notice": {
        const one = entry as { text?: unknown; tone?: unknown };
        const text = clip(one.text, PLUGIN_VIEW_LIMITS.text);
        if (String(one.text ?? "").length > text.length) clamped = true;
        blocks.push(
          block.type === "text"
            ? { type: "text", text, tone: one.tone === "muted" ? "muted" : "default" }
            : { type: "notice", text, tone: one.tone === "danger" ? "danger" : "default" },
        );
        break;
      }
      case "list": {
        const one = entry as { rows?: unknown; empty?: unknown };
        const rows = clampRows(one.rows, () => (clamped = true));
        blocks.push({ type: "list", rows, empty: clip(one.empty, PLUGIN_VIEW_LIMITS.short) });
        break;
      }
      case "columns": {
        const one = entry as { columns?: unknown };
        const raw = Array.isArray(one.columns) ? one.columns : [];
        if (raw.length > PLUGIN_VIEW_LIMITS.columns) clamped = true;
        const columns = raw.slice(0, PLUGIN_VIEW_LIMITS.columns).map((column) => {
          const it = (column ?? {}) as { title?: unknown; rows?: unknown };
          return {
            title: clip(it.title, PLUGIN_VIEW_LIMITS.short),
            rows: clampRows(it.rows, () => (clamped = true)),
          };
        });
        blocks.push({ type: "columns", columns });
        break;
      }
      case "form": {
        const one = entry as { fields?: unknown; submit?: unknown; action?: unknown };
        const raw = Array.isArray(one.fields) ? one.fields : [];
        if (raw.length > PLUGIN_VIEW_LIMITS.fields) clamped = true;
        const fields = raw.slice(0, PLUGIN_VIEW_LIMITS.fields).map((field) => clampField(field, () => (clamped = true)));
        blocks.push({
          type: "form",
          fields,
          submit: clip(one.submit, PLUGIN_VIEW_LIMITS.short),
          action: clip(one.action, PLUGIN_VIEW_LIMITS.short),
        });
        break;
      }
      default:
        // Something this daemon does not draw. Dropped rather than forwarded: the
        // client would drop it too, and forwarding spends bytes on a phone to
        // deliver nothing.
        clamped = true;
        break;
    }
  }

  const title = source.title === null || source.title === undefined ? null : clip(source.title, PLUGIN_VIEW_LIMITS.short);
  return { view: { title, refreshMs: clampRefresh(source.refreshMs), blocks }, clamped };
}

/**
 * A refresh interval, or `null`.
 *
 * Clamped rather than refused, and **silently** — unlike a cut list, which is
 * reported. The difference is what a person could do about it: a list that was
 * shortened is a wrong number on screen, while an interval moved from 500ms to
 * 2000ms is invisible to everyone and actionable by nobody. Anything that is not
 * a usable number at all is `null`, which is the same as not asking.
 */
function clampRefresh(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  if (raw > PLUGIN_REFRESH_MAX_MS) return PLUGIN_REFRESH_MAX_MS;
  return Math.max(PLUGIN_REFRESH_MIN_MS, Math.round(raw));
}

/**
 * A destination, or `null` for a row that does not go anywhere.
 *
 * Narrowed here rather than trusted, because this is the field a plugin would
 * most like to put a URL in: anything that is not one of the two known shapes —
 * including `{url: …}` — becomes `null` and the row simply is not tappable.
 */
function clampOpen(raw: unknown): PluginOpen | null {
  if (raw === null || typeof raw !== "object") return null;
  const open = raw as { session?: unknown; screen?: unknown };
  if (typeof open.session === "string" && open.session.length > 0) {
    return { session: clip(open.session, PLUGIN_VIEW_LIMITS.short) };
  }
  return open.screen === true ? { screen: true } : null;
}

function clampRows(raw: unknown, cut: () => void): PluginRow[] {
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length > PLUGIN_VIEW_LIMITS.rows) cut();
  return rows.slice(0, PLUGIN_VIEW_LIMITS.rows).map((entry) => {
    const row = (entry ?? {}) as {
      id?: unknown;
      title?: unknown;
      subtitle?: unknown;
      badge?: unknown;
      tone?: unknown;
      open?: unknown;
      actions?: unknown;
    };
    const actions = Array.isArray(row.actions) ? row.actions : [];
    if (actions.length > PLUGIN_VIEW_LIMITS.actionsPerRow) cut();
    const tones: readonly PluginRowTone[] = ["ok", "warn", "danger"];
    return {
      id: clip(row.id, PLUGIN_VIEW_LIMITS.short),
      title: clip(row.title, PLUGIN_VIEW_LIMITS.short),
      subtitle: row.subtitle === null || row.subtitle === undefined ? null : clip(row.subtitle, PLUGIN_VIEW_LIMITS.short),
      badge: row.badge === null || row.badge === undefined ? null : clip(row.badge, PLUGIN_VIEW_LIMITS.short),
      // An unrecognised tone is no tone. A plugin can fail to mark something as
      // wrong and cannot mark something wrong as fine, which is the direction
      // every guess in this file is chosen to fall.
      tone: tones.find((one) => one === row.tone) ?? null,
      open: clampOpen(row.open),
      actions: actions.slice(0, PLUGIN_VIEW_LIMITS.actionsPerRow).map((entry) => {
        const action = (entry ?? {}) as { id?: unknown; label?: unknown; tone?: unknown; confirm?: unknown };
        return {
          id: clip(action.id, PLUGIN_VIEW_LIMITS.short),
          label: clip(action.label, PLUGIN_VIEW_LIMITS.short),
          tone: action.tone === "destructive" ? ("destructive" as const) : ("plain" as const),
          confirm:
            action.confirm === null || action.confirm === undefined ? null : clip(action.confirm, PLUGIN_VIEW_LIMITS.short),
        };
      }),
    };
  });
}

function clampField(raw: unknown, cut: () => void): PluginField {
  const field = (raw ?? {}) as {
    key?: unknown;
    label?: unknown;
    kind?: unknown;
    value?: unknown;
    options?: unknown;
    placeholder?: unknown;
    help?: unknown;
  };
  const options = Array.isArray(field.options) ? field.options : [];
  if (options.length > PLUGIN_VIEW_LIMITS.options) cut();
  const kinds: readonly PluginFieldKind[] = ["text", "password", "number", "toggle", "select"];
  const kind = kinds.find((one) => one === field.kind) ?? "text";
  return {
    key: clip(field.key, PLUGIN_VIEW_LIMITS.short),
    label: clip(field.label, PLUGIN_VIEW_LIMITS.short),
    kind,
    value: field.value === null || field.value === undefined ? null : clip(field.value, PLUGIN_VIEW_LIMITS.text),
    options: options.slice(0, PLUGIN_VIEW_LIMITS.options).map((entry) => {
      const option = (entry ?? {}) as { value?: unknown; label?: unknown };
      return { value: clip(option.value, PLUGIN_VIEW_LIMITS.short), label: clip(option.label, PLUGIN_VIEW_LIMITS.short) };
    }),
    placeholder:
      field.placeholder === null || field.placeholder === undefined ? null : clip(field.placeholder, PLUGIN_VIEW_LIMITS.short),
    help: field.help === null || field.help === undefined ? null : clip(field.help, PLUGIN_VIEW_LIMITS.text),
  };
}

/**
 * One installed plugin, as `GET /plugins` reports it.
 *
 * `state` is derived from what the host knows right now and is never stored, for
 * the reason `ManagedSession.status` is not: a stored state drifts from the thing
 * it describes, and the only reader is a screen that redraws anyway.
 */
export type PluginState = "running" | "stopped" | "failed" | "starting";

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string | null;
  scopes: readonly PluginScope[];
  net: readonly string[];
  contributes: PluginContributions;
  enabled: boolean;
  state: PluginState;
  /** What went wrong last, clipped. `null` when nothing has. */
  failure: string | null;
  installedAt: number;
  updatedAt: number;
}
