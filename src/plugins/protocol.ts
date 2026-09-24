// Mirrored by hand into packages/web/src/wire.ts, so this file may import nothing, not even node builtins.

/**
 * Newest plugin api this daemon speaks. Bump it for any new manifest field, scope or method;
 * manifest.ts negotiates api before reading scopes and contributes, and the bump relies on that order.
 */
export const PLUGIN_API_VERSION = 5;

export const PLUGIN_API_MIN_VERSION = 1;

export type PluginApiVerdict = "ok" | "too_old" | "too_new";

/** Two refusals because they need opposite fixes: republish the plugin, or update the machine. */
export function negotiatePluginApi(declared: number): PluginApiVerdict {
  if (declared < PLUGIN_API_MIN_VERSION) return "too_old";
  if (declared > PLUGIN_API_VERSION) return "too_new";
  return "ok";
}

/** What the plugin may do, never a token scope. Hygiene, not a fence: the child runs as this uid. */
export type PluginScope =
  | "sessions.read"
  | "sessions.write"
  | "files.read"
  | "store"
  | "net"
  | "model"
  | "harness"
  | "system";

export const PLUGIN_SCOPES: readonly PluginScope[] = [
  "sessions.read",
  "sessions.write",
  "files.read",
  "store",
  "net",
  "model",
  // harness and system gate nothing at call time (declarations read at install), so SCOPE_OF does not grow.
  "harness",
  "system",
];

// Each scope's consent sentence lives in packages/web/src/wire.ts; a new scope needs one there.

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
  "permission.resolved",
];

/** Where an action is offered. `session` is the session menu; `screen` is the plugin's own. */
export type PluginActionSurface = "session" | "screen";

export interface PluginAction {
  id: string;
  title: string;
  on: PluginActionSurface;
}

/** A harness a plugin adds, declared rather than coded; it has no login flow, like opencode (Q7.31). */
export interface HarnessContribution {
  /** Local; the effective id this daemon uses is `<pluginId>:<id>`. */
  id: string;
  name: string;
  /** A bare name resolved on PATH, never a path: no sync filesystem call on a location this daemon did not create. */
  command: string;
  args: readonly string[];
  envNames: readonly string[];
  /** Variables set to a routed model id; empty means hostable refuses routing through this harness. */
  routedModelEnv: readonly string[];
  authHint: string | null;
}

/** A system a plugin adds; contributions.ts turns it into a SYSTEMS row. */
export interface SystemContribution {
  id: string;
  name: string;
  apiType: "anthropic" | "openai";
  /** Where routed traffic goes, or null for native-only; a null row must name a nativeHarness. */
  baseUrl: string | null;
  authHeader: { name: string; prefix: string } | null;
  models: readonly { id: string; name: string }[];
  /** Only ever a harness this same plugin contributes, never a built-in (Q3.488). */
  nativeHarness: string | null;
  loginVia: string | null;
  nativeModelPrefix: string | null;
  keyEnv: string | null;
}

/** The six places a plugin may appear; closed so nothing can insert rows into the session list. */
export interface PluginContributions {
  /** A full screen, reached at `/p/:machineId/:pluginId`. `null` for no screen. */
  screen: { title: string } | null;
  settings: boolean;
  actions: readonly PluginAction[];
  hooks: readonly PluginHook[];
  /** Harnesses this plugin adds. Empty unless `scopes` holds `harness`. */
  harnesses: readonly HarnessContribution[];
  /** Systems this plugin adds. Empty unless `scopes` holds `system`. */
  systems: readonly SystemContribution[];
}

export interface PluginManifest {
  /** Lower-case: it becomes a directory name and a URL segment on case-insensitive filesystems. */
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

export type PluginRowActionTone = "plain" | "destructive";

export interface PluginRowAction {
  id: string;
  label: string;
  tone: PluginRowActionTone;
  confirm: string | null;
}

/** A meaning, not a colour: the host picks the ink. */
export type PluginRowTone = "ok" | "warn" | "danger";

/** A destination inside this app, never a URL. */
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

const UNKNOWN_BLOCK_NAME_MAX = 40;

const UNKNOWN_BLOCKS_NAMED = 3;

/** The whole drawing vocabulary: a plugin sends a description, never markup or code, so the browser runs nothing it wrote. */
export const PLUGIN_BLOCK_TYPES = ["text", "notice", "list", "columns", "form"] as const;

export type PluginSurface = "screen" | "settings";

/** A settings pane draws a form and the words around it; rows belong on the plugin's screen. */
export const PLUGIN_SETTINGS_BLOCK_TYPES = ["text", "notice", "form"] as const;

/** Not checked for exhaustiveness against PluginFieldKind: add a new kind here too. */
export const PLUGIN_FIELD_KINDS: readonly PluginFieldKind[] = ["text", "password", "number", "toggle", "select"];

/** number and password draw as text on a settings pane and are reported as substituted (the value is stored in plaintext). */
export const PLUGIN_SETTINGS_FIELD_KINDS = ["text", "toggle", "select"] as const;

export type PluginBlock =
  | { type: "text"; text: string; tone: "default" | "muted" }
  | { type: "notice"; text: string; tone: "default" | "danger" }
  | { type: "list"; rows: readonly PluginRow[]; empty: string }
  | { type: "columns"; columns: readonly { title: string; rows: readonly PluginRow[] }[] }
  | { type: "form"; fields: readonly PluginField[]; submit: string; action: string };

export interface PluginView {
  title: string | null;
  /** Re-read interval, clamped by the host and spent only while the screen is visible; null for never. */
  refreshMs: number | null;
  blocks: readonly PluginBlock[];
}

export type PluginResult =
  | { kind: "view"; view: PluginView }
  | { kind: "toast"; text: string; tone: "default" | "danger" };

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

export interface ClampedView {
  view: PluginView;
  clamped: boolean;
  /** Unknown block types in arrival order, deduplicated and capped at UNKNOWN_BLOCKS_NAMED. */
  unknownBlocks: readonly string[];
  substituted: boolean;
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

export function clampView(raw: unknown, surface: PluginSurface = "screen"): ClampedView {
  const drawable: readonly string[] = surface === "settings" ? PLUGIN_SETTINGS_BLOCK_TYPES : PLUGIN_BLOCK_TYPES;
  let clamped = false;
  const unknownBlocks: string[] = [];
  let substituted = false;
  const source = (raw ?? {}) as { title?: unknown; blocks?: unknown; refreshMs?: unknown };
  const rawBlocks = Array.isArray(source.blocks) ? source.blocks : [];
  if (rawBlocks.length > PLUGIN_VIEW_LIMITS.blocks) clamped = true;

  const blocks: PluginBlock[] = [];
  for (const entry of rawBlocks.slice(0, PLUGIN_VIEW_LIMITS.blocks)) {
    const block = entry as { type?: unknown };
    switch (drawable.includes(String(block.type)) ? String(block.type) : null) {
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
        const fields = raw
          .slice(0, PLUGIN_VIEW_LIMITS.fields)
          .map((field) => clampField(field, () => (clamped = true), () => (substituted = true), surface));
        const action = clip(one.action, PLUGIN_VIEW_LIMITS.short);
        // A form with no action submits to an action named empty, so report it.
        if (action.length === 0) substituted = true;
        blocks.push({
          type: "form",
          fields,
          submit: clip(one.submit, PLUGIN_VIEW_LIMITS.short),
          action,
        });
        break;
      }
      default:
        // Not drawn on this surface: dropped, and reported as a shape problem (substituted), not a size one (clamped).
        substituted = true;
        {
          const name = clip((block as { type?: unknown }).type, UNKNOWN_BLOCK_NAME_MAX);
          const shown = name.length === 0 ? "(no type)" : name;
          if (unknownBlocks.length < UNKNOWN_BLOCKS_NAMED && !unknownBlocks.includes(shown)) {
            unknownBlocks.push(shown);
          }
        }
        break;
    }
  }

  const title = source.title === null || source.title === undefined ? null : clip(source.title, PLUGIN_VIEW_LIMITS.short);
  return { view: { title, refreshMs: clampRefresh(source.refreshMs), blocks }, clamped, substituted, unknownBlocks };
}

export function noteClamp(clamped: ClampedView, surface: PluginSurface = "screen"): PluginView {
  if (!clamped.clamped && !clamped.substituted) return clamped.view;
  const notices: PluginBlock[] = [];
  if (clamped.clamped) {
    notices.push({ type: "notice", text: "Some of what this plugin returned was too large to show.", tone: "default" });
  }
  if (clamped.substituted) {
    notices.push({
      type: "notice",
      text: substitutedText(surface, clamped.unknownBlocks),
      tone: "default",
    });
  }
  return {
    title: clamped.view.title,
    refreshMs: clamped.view.refreshMs,
    blocks: [...clamped.view.blocks, ...notices],
  };
}

function substitutedText(surface: PluginSurface, unknownBlocks: readonly string[]): string {
  const draws = surface === "settings" ? PLUGIN_SETTINGS_BLOCK_TYPES : PLUGIN_BLOCK_TYPES;
  const who = surface === "settings" ? "A settings pane" : "This machine";
  if (unknownBlocks.length === 0) {
    return surface === "settings"
      ? `Part of what this plugin sent is not something a settings pane draws, so some controls here will not work. A setting is one of: ${PLUGIN_SETTINGS_FIELD_KINDS.join(", ")}.`
      : "Part of what this plugin sent is not in a shape this machine recognises, so some controls here will not work.";
  }
  return `${who} does not draw blocks of type ${unknownBlocks.map((one) => JSON.stringify(one)).join(", ")}, so that part is missing. It draws: ${draws.join(", ")}.`;
}

function rowsIn(view: PluginView): number {
  let most = 0;
  for (const block of view.blocks) {
    if (block.type === "list") most = Math.max(most, block.rows.length);
    else if (block.type === "columns") for (const column of block.columns) most = Math.max(most, column.rows.length);
  }
  return most;
}

function withBlockCap(view: PluginView, keep: number): PluginView {
  return { title: view.title, refreshMs: view.refreshMs, blocks: view.blocks.slice(0, keep) };
}

function withRowCap(view: PluginView, cap: number): PluginView {
  return {
    title: view.title,
    refreshMs: view.refreshMs,
    blocks: view.blocks.map((block) => {
      if (block.type === "list") return { ...block, rows: block.rows.slice(0, cap) };
      if (block.type === "columns") {
        return { ...block, columns: block.columns.map((column) => ({ ...column, rows: column.rows.slice(0, cap) })) };
      }
      return block;
    }),
  };
}

function wireBytes(view: PluginView): number {
  return new TextEncoder().encode(JSON.stringify(view)).length;
}

/**
 * Cuts a view until it fits the IPC budget: rows halved first, then trailing blocks, then title only.
 * clamped reports only an actual cut; substituted and unknownBlocks carry over from the first pass.
 */
export function fitView(raw: unknown, budget: number, surface: PluginSurface = "screen"): ClampedView {
  const first = clampView(raw, surface);
  const carried = { substituted: first.substituted, unknownBlocks: first.unknownBlocks };
  if (wireBytes(first.view) <= budget) return first;

  let cut = first.view;
  let cap = rowsIn(first.view);
  while (cap > 0) {
    cap = Math.floor(cap / 2);
    cut = withRowCap(first.view, cap);
    if (wireBytes(cut) <= budget) return { view: cut, clamped: true, ...carried };
  }

  for (let keep = cut.blocks.length - 1; keep >= 0; keep -= 1) {
    const fewer = withBlockCap(cut, keep);
    if (wireBytes(fewer) <= budget) return { view: fewer, clamped: true, ...carried };
  }

  return { view: { title: cut.title, refreshMs: cut.refreshMs, blocks: [] }, clamped: true, ...carried };
}

function clampRefresh(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  if (raw > PLUGIN_REFRESH_MAX_MS) return PLUGIN_REFRESH_MAX_MS;
  return Math.max(PLUGIN_REFRESH_MIN_MS, Math.round(raw));
}

/** Anything but the two known shapes, including a URL, becomes null. */
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

function clampField(raw: unknown, cut: () => void, swap: () => void, surface: PluginSurface = "screen"): PluginField {
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
  const kinds: readonly PluginFieldKind[] = surface === "settings" ? PLUGIN_SETTINGS_FIELD_KINDS : PLUGIN_FIELD_KINDS;
  // An omitted kind is a plain text field; an unknown one (password on settings too) is reported as substituted.
  const known = kinds.find((one) => one === field.kind);
  if (known === undefined && field.kind !== undefined && field.kind !== null) swap();
  const kind = known ?? "text";
  const key = clip(field.key, PLUGIN_VIEW_LIMITS.short);
  // A keyless field cannot round-trip: every one collapses onto the empty key.
  if (key.length === 0) swap();
  return {
    key,
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
  failure: string | null;
  installedAt: number;
  updatedAt: number;
}
