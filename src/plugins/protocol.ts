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
 *
 * **v3 added the `model` scope, and the ceiling moved again for a sharper reason
 * than v2's.** A new *scope* is not like a new field: `parseManifest` refuses an
 * unknown one outright, so without a bump a plugin declaring `model` is told
 * `manifest_invalid: unknown scope "model"` by every daemon that has not been
 * updated — which says *the plugin is wrong*, and sends its author looking for a
 * mistake in somebody else's code. Declaring `3` gets `plugin_api_too_new` and
 * names the machine instead. ⚠ **That only works because `api` is negotiated
 * before `scopes` are read** (`manifest.ts`: api at the top, scopes below it); the
 * two are ordered, and reversing them would make this bump buy nothing.
 *
 * **v4 added `model.list` and the optional `model` on `model.complete`, and the
 * ceiling moved for v2's reason rather than v3's.** A new *method* is not refused
 * at install the way an unknown scope is — `SCOPE_OF` decides at call time — so a
 * plugin declaring `3` and calling `ctx.model.list` gets `unknown_method` from an
 * older daemon, at the moment somebody presses something, with nothing on screen
 * saying which of the two is out of date. Declaring `4` moves that to install and
 * names the machine. A plugin that only wants to *pass* a model needs no bump at
 * all: the field is optional and an older daemon ignores it, which means the
 * naming quietly runs on the agent's default — worth knowing, and not worth
 * refusing an install over.
 */
export const PLUGIN_API_VERSION = 4;

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
export type PluginScope = "sessions.read" | "sessions.write" | "files.read" | "store" | "net" | "model";

export const PLUGIN_SCOPES: readonly PluginScope[] = [
  "sessions.read",
  "sessions.write",
  "files.read",
  "store",
  "net",
  /*
   * ⚠ **The one scope that spends the operator's money, and the only one whose
   * sentence has to say so.**
   *
   * `model` lets a plugin put one short prompt through an agent this machine is
   * already signed in to, and take the text back. It is *not* `net` — nothing
   * outbound is chosen by the plugin — and it is not `sessions.write`: no session
   * is created that anybody can see, prompt or find.
   *
   * The alternative it replaced was worse in the way that matters here. A plugin
   * wanting a model could hold `net` and its own API key, and then the consent
   * screen said "reaches api.anthropic.com" while the person supplied a second
   * credential by hand. Reading the machine's *own* agent credential instead was
   * considered and refused: there is no scope for it and there could not be one —
   * "read the credentials your agents are signed in with" is a line nobody would
   * agree to, so the capability would have existed only in a form this system can
   * hide. Which is the one thing `SECURITY.md` says the scope table exists to
   * prevent.
   */
  "model",
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
/**
 * The block types this daemon draws, as a value.
 *
 * ⚠ **A constant rather than a comment, because it is now printed to a person.**
 * When a view carries a `type` nobody here knows, the notice names it *and* names
 * these — and a list typed out a second time in a sentence is a list that drifts
 * away from the union it is describing. `webcheck` already compares the union's
 * members across the mirror; this is the same discipline one layer in.
 */
/** How much of an invented block `type` is repeated back to a person. */
const UNKNOWN_BLOCK_NAME_MAX = 40;

/** How many distinct invented types the notice names before it stops. */
const UNKNOWN_BLOCKS_NAMED = 3;

export const PLUGIN_BLOCK_TYPES = ["text", "notice", "list", "columns", "form"] as const;

/**
 * Which of a plugin's two screens is being drawn.
 *
 * ⚠ **Not a decoration on a log line: the two surfaces draw different
 * vocabularies, and this is what decides which.** A plugin's *screen* is a thing
 * somebody looks at, so it gets all five blocks and every field kind. A
 * **settings pane** is a thing somebody fills in, and it is bounded to three
 * controls and nothing else — see {@link PLUGIN_SETTINGS_BLOCK_TYPES}.
 *
 * The value is the `viewId` the route already parses (`server.ts` refuses any
 * third one) and the `name` the child is already invoked with, so nothing new
 * travels: what was missing was that neither side used it.
 */
export type PluginSurface = "screen" | "settings";

/**
 * What a settings pane may draw.
 *
 * ⚠ **A settings pane is a form, plus the words around it — never a screen that
 * happens to be reached from settings.** It could draw all five blocks, so a
 * plugin could put a list of rows with their own action buttons, or a two-column
 * board, on the pane whose whole job is *"what do I want this thing to do"*. The
 * vocabulary was unbounded and the screen was the only thing bounding it.
 *
 * `text` and `notice` stay because neither is a setting: they are the sentence
 * above a control and the warning beside it — *"you are not signed in yet"* — and
 * a form with no way to say anything about itself is a worse pane, not a
 * stricter one.
 *
 * `list` and `columns` go, and a plugin that needs rows has a **screen** for
 * them, reached at `/p/:machineId/:pluginId`. That is the same split this
 * subsystem already makes everywhere else: configuration is a form, and looking
 * at things is a screen.
 */
export const PLUGIN_SETTINGS_BLOCK_TYPES = ["text", "notice", "form"] as const;

/**
 * The three controls a setting may be, and there is no fourth.
 *
 * A box you type in, a switch, and a dropdown. Everything a plugin wants to
 * configure is one of those three, and the two that were dropped were not a
 * fourth and a fifth kind of setting — they were *spellings of the first*:
 *
 *   - **`number`** never round-tripped as a number. {@link PluginField.value} is
 *     `string | null` on the wire by design ("one narrowing, not five"), so the
 *     plugin parsed a string either way and all the kind ever bought was a
 *     numeric keyboard on a phone.
 *   - **`password`** masked a value that is kept in `plugin_data`, which is a
 *     column in a plaintext SQLite file that everything running as this uid can
 *     read — including the plugin next to it. So the mask was an assurance this
 *     system does not provide, on the one screen in the product where a false
 *     assurance is most expensive. `SECURITY.md` says a plugin's blast radius is
 *     *named* rather than fenced; a password box says the opposite in one glyph.
 *
 * A field arriving with either kind on a settings pane is drawn as a text box and
 * **reported as a substitution**, so its author finds out rather than shipping a
 * pane that looks masked and is not. On a plugin's own *screen* both still draw,
 * because that surface is not this decision's subject and narrowing it would be a
 * breaking change bought for nothing.
 */
export const PLUGIN_SETTINGS_FIELD_KINDS = ["text", "toggle", "select"] as const;

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

/**
 * What a clamp did, so a caller can say so rather than hide it.
 *
 * ⚠ **Two facts and not one, because they send an author to two different
 * places.** "Too large" means look at the bounds; "not a shape this daemon
 * knows" means look at the protocol. One flag with one sentence about size told
 * the second author to go and count things.
 */
export interface ClampedView {
  view: PluginView;
  /** True when anything at all was cut for being too large. Drawn as a line, never swallowed. */
  clamped: boolean;
  /**
   * The block `type` values this build does not draw, in the order they arrived.
   *
   * ⚠ **Names rather than a count, and this is the difference between a notice
   * and a diagnosis.** Saying *something was not in a shape this machine
   * recognises* is true and leaves an author with the whole protocol to search.
   * Saying *it does not draw blocks of type "actions"* ends the search.
   *
   * Measured: an author invented `{type: "actions"}` in an evening without reading
   * the five that exist. It rendered as nothing, said nothing about itself, and
   * the only way the cause was found was by running this very function over the
   * payload by hand — which the author could do because they happen to have this
   * repository, and which nobody writing a plugin can.
   *
   * Bounded and deduplicated: the value comes from a plugin and a hostile or
   * broken one can send a great many distinct ones. What a person needs is the
   * first few.
   */
  unknownBlocks: readonly string[];
  /**
   * True when a value this daemon does not recognise was **substituted**, or an
   * identifier a control needs was missing and became `""`.
   *
   * ⚠ **This exists because fail-open protected the client and guaranteed the
   * plugin author would never find out.** `plugins.ts`'s rule — an unknown field
   * kind becomes a text input and still round-trips, nothing throws — is right
   * and stays. What it did *not* do is say so, and a substitution is far worse
   * than a truncation for exactly that reason: a cut list is visibly short,
   * while a form whose fields all lost their `key` renders perfectly, submits
   * nothing, and looks like it works.
   *
   * Measured on a real plugin: a settings pane shipped to the market with every
   * field sending `id` where `clampField` reads `key`, and a form sending
   * `submit` where the identifier belongs. Three fields collapsed onto one empty
   * key, the submit called an action named `""`, and it survived two releases —
   * because the only thing that could have caught it was the plugin's own driver,
   * which asserted the author's misunderstanding rather than the protocol.
   */
  substituted: boolean;
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
export function clampView(raw: unknown, surface: PluginSurface = "screen"): ClampedView {
  /*
   * ⚠ **Defaulted to `screen`, and that default is the safe direction.** Every
   * caller that has not been told which surface it is on gets the *wider*
   * vocabulary — so a missed call site draws a settings pane as though it were a
   * screen, which is exactly today's behaviour, rather than silently deleting
   * controls off somebody's pane. The narrowing is opt-in at the two places that
   * know: the route in `server.ts` and the invoke in `runner.ts`, both of which
   * already carry the name.
   */
  const drawable: readonly string[] = surface === "settings" ? PLUGIN_SETTINGS_BLOCK_TYPES : PLUGIN_BLOCK_TYPES;
  let clamped = false;
  /**
   * Block types this build does not draw. Bounded and deduplicated — see
   * {@link ClampedView.unknownBlocks}.
   */
  const unknownBlocks: string[] = [];
  /** See {@link ClampedView.substituted}. Raised where a value was replaced. */
  let substituted = false;
  const source = (raw ?? {}) as { title?: unknown; blocks?: unknown; refreshMs?: unknown };
  const rawBlocks = Array.isArray(source.blocks) ? source.blocks : [];
  if (rawBlocks.length > PLUGIN_VIEW_LIMITS.blocks) clamped = true;

  const blocks: PluginBlock[] = [];
  for (const entry of rawBlocks.slice(0, PLUGIN_VIEW_LIMITS.blocks)) {
    const block = entry as { type?: unknown };
    /*
     * ⚠ **The surface decides the vocabulary *before* the switch, rather than
     * each arm asking.** A block this surface does not draw falls into `default:`
     * — the same arm, the same notice, the same naming — so there is one way for
     * a block to be missing rather than two, and adding a block type cannot leave
     * a settings pane quietly accepting it.
     */
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
        /*
         * ⚠ **A form with no `action` cannot submit anywhere, and used to say
         * nothing about it.** `clip(undefined)` is `""`, so the button called an
         * action named `""` and the plugin's `if (event.action === …)` never
         * matched. It rendered perfectly. `submit` is the *label* on that button
         * and is a different field — sending one where the other belongs is the
         * exact mistake this caught in the wild.
         */
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
        /*
         * Something this surface does not draw. Dropped rather than forwarded: the
         * client would drop it too, and forwarding spends bytes on a phone to
         * deliver nothing.
         *
         * ⚠ **Two different facts arrive here and the notice tells them apart.**
         * On a screen this is a `type` nobody has ever heard of. On a settings
         * pane it is more often a `list` or a `columns` — real blocks, which this
         * daemon draws perfectly one surface over — so the sentence has to say
         * *a settings pane does not draw this* rather than *this machine does
         * not*, or an author goes looking for a typo in a block type that is
         * spelled correctly. {@link noteClamp} takes the surface for that one
         * reason.
         *
         * ⚠ **`substituted`, not `clamped`, and the difference is the whole reason
         * these are two flags.** Nothing here was too large — no ceiling was
         * reached, no row was cut, no string was clipped. A `type` this build has
         * never heard of is a *shape* problem, and the two notices send an author
         * to two different places: one says "look at the bounds", the other says
         * "look at the list of block types". Reported as a size clamp, an author
         * goes and counts elements.
         *
         * Measured on a real plugin the day this was found: a screen returned a
         * `list` and an `{type: "actions"}` block that does not exist. The list had
         * one row, nothing exceeded anything, and the screen said *"some of what
         * this plugin returned was too large to show"* — while the invented block
         * rendered as nothing and complained about nothing. The author had made up
         * a block type in an evening without reading the five, and was told about
         * bytes.
         *
         * ⚠ **The check that covered this line asserted `.clamped === true`**, so
         * it pinned the wrong channel — written when there was one flag and never
         * revisited when there were two. That is the same failure as the code, in
         * the one place that could have caught it.
         */
        substituted = true;
        {
          /*
           * ⚠ **Clipped short and capped at three, because this string is a
           * plugin's and it is about to be read by a person.** `short` is 200,
           * which is a sentence rather than a type name, and a broken plugin can
           * send a different invented type in every one of its 24 blocks. Three
           * names answer "which one did I make up"; twenty-four is the same wall
           * of text the notice replaced.
           */
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

/**
 * A clamped view, with a line saying it was clamped.
 *
 * **Said rather than hidden**, which is the same rule the transcript keeps about a
 * conversation it could not draw in full: a list silently cut is a list showing a
 * wrong number, and the person reading it has no way to find that out. One notice
 * at the foot costs a row and makes the screen honest.
 *
 * Here rather than in `host.ts` because {@link fitView} runs in the **child**, and
 * a notice added on one side of the channel and not the other is a cut nobody is
 * told about. Applying it twice is a no-op: the host's own pass finds nothing left
 * to clamp and adds nothing.
 */
export function noteClamp(clamped: ClampedView, surface: PluginSurface = "screen"): PluginView {
  if (!clamped.clamped && !clamped.substituted) return clamped.view;
  /*
   * One notice per fact, because they are two different things to do about it —
   * and both, where both happened. The size line is about bounds; the shape line
   * is about the protocol, and it is the one whose absence let a broken form ship
   * twice.
   */
  const notices: PluginBlock[] = [];
  if (clamped.clamped) {
    notices.push({ type: "notice", text: "Some of what this plugin returned was too large to show.", tone: "default" });
  }
  if (clamped.substituted) {
    notices.push({
      type: "notice",
      /*
       * Written to be true for a person and useful to an author, because both
       * read it: the author only ever sees it by opening their own plugin. So it
       * names the consequence ("will not work") rather than the mechanism, and
       * does not pretend to know which control.
       *
       * ⚠ **Where the shape problem is a block type, it is *named*, and the five
       * that exist are named beside it.** That turns a notice into a diagnosis,
       * and the difference is not cosmetic: an author has no copy of this
       * protocol, so without the names the only way left to find the cause is to
       * obtain this repository and run this function over the payload by hand.
       * That is exactly what happened, and it worked only because the author of
       * the plugin in question happened to have it.
       *
       * Still one notice rather than two: a form with a bad field *and* an
       * invented block is one answer to "why does this screen not work", and
       * splitting it would put the same person in front of two lines about one
       * mistake.
       */
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

/**
 * The shape notice, worded for the surface it is about.
 *
 * ⚠ **"This machine does not draw" is false on a settings pane** — the commonest
 * thing to land here is a `list`, which this machine draws perfectly well one
 * surface over. Told that, an author goes looking for a typo in a block type they
 * spelled correctly, which is the same wrong-diagnosis failure the named-types
 * branch exists to end.
 *
 * Both branches name the vocabulary that *does* apply, because an author has no
 * copy of this protocol and the alternative is obtaining this repository and
 * running `clampView` over the payload by hand. That is not a hypothetical: it is
 * how the last one was found.
 */
function substitutedText(surface: PluginSurface, unknownBlocks: readonly string[]): string {
  const draws = surface === "settings" ? PLUGIN_SETTINGS_BLOCK_TYPES : PLUGIN_BLOCK_TYPES;
  const who = surface === "settings" ? "A settings pane" : "This machine";
  if (unknownBlocks.length === 0) {
    /*
     * No block was refused, so what was substituted was inside one — a field with
     * no `key`, a form with no `action`, or a `kind` this surface does not draw.
     * The settings wording names the three controls, because on that surface the
     * commonest cause is `password` or `number`, and "not in a shape this machine
     * recognises" is exactly wrong about a kind the machine recognises and
     * declines.
     */
    return surface === "settings"
      ? `Part of what this plugin sent is not something a settings pane draws, so some controls here will not work. A setting is one of: ${PLUGIN_SETTINGS_FIELD_KINDS.join(", ")}.`
      : "Part of what this plugin sent is not in a shape this machine recognises, so some controls here will not work.";
  }
  return `${who} does not draw blocks of type ${unknownBlocks.map((one) => JSON.stringify(one)).join(", ")}, so that part is missing. It draws: ${draws.join(", ")}.`;
}

/** The rows of every block that has any, as one number. */
function rowsIn(view: PluginView): number {
  let most = 0;
  for (const block of view.blocks) {
    if (block.type === "list") most = Math.max(most, block.rows.length);
    else if (block.type === "columns") for (const column of block.columns) most = Math.max(most, column.rows.length);
  }
  return most;
}

/** The same view with no list or column longer than `cap`. */
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

/** What this view costs on the wire, in bytes rather than in characters. */
function wireBytes(view: PluginView): number {
  return new TextEncoder().encode(JSON.stringify(view)).length;
}

/**
 * A view cut until it **fits the channel**, rather than refused for not fitting.
 *
 * ⚠ **`PLUGIN_VIEW_LIMITS` was enforced on the wrong side of the wire, and could
 * therefore never do its job.** {@link clampView} ran in the host — after the
 * child's answer had already crossed IPC — while the child refuses to send
 * anything over `MAX_PLUGIN_MESSAGE_BYTES`. So the two bounds sit two lines apart
 * in the author's guide as though both applied, and only the smaller one ever
 * did: a view inside every documented limit was refused with "this plugin
 * returned more than can be sent", and the clamp that exists to cut it never saw
 * it.
 *
 * Measured 2026-08-23 against a real forked child, the reference plugin and a
 * real store: its board fits at 903 cards and does not at 904, while the store
 * lets a plugin keep 1000 keys and the session prune never removes them. So a
 * plugin doing exactly what the guide walks through reaches a screen that cannot
 * be drawn — permanently, and with nothing in the interface able to shrink it,
 * because the only control that deletes a card belongs to a session that by then
 * no longer exists.
 *
 * **Rows are the only unbounded dimension**, which is why they are the lever.
 * Blocks, text, fields and columns are each bounded by a count that is small
 * enough to be irrelevant against 256 KiB; the number of rows a plugin has is
 * whatever its data grew to. So the cap is halved until the message fits, which
 * is at most eight measurements and terminates at zero rows.
 *
 * Both bounds still hold afterwards, and neither is now a claim the other
 * quietly overrules.
 */
export function fitView(raw: unknown, budget: number, surface: PluginSurface = "screen"): ClampedView {
  const first = clampView(raw, surface);
  if (wireBytes(first.view) <= budget) return first;

  let cap = rowsIn(first.view);
  let cut = first.view;
  while (cap > 0) {
    cap = Math.floor(cap / 2);
    cut = withRowCap(first.view, cap);
    if (wireBytes(cut) <= budget) break;
  }
  // `clamped` unconditionally: reaching here means something was dropped, and at
  // `cap === 0` it means every row was — which the notice must still say.
  // `substituted` is carried through from the first pass rather than invented:
  // cutting rows for size replaces nothing, and claiming it did would send an
  // author looking for a shape problem this pass did not create.
  // Carried through: cutting rows for size neither creates nor resolves a block
  // type nobody here knows, and losing the names would make the second pass a
  // worse diagnosis than the first.
  return { view: cut, clamped: true, substituted: first.substituted, unknownBlocks: first.unknownBlocks };
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
  /*
   * ⚠ **A settings pane knows three kinds and a screen knows five**, and the two
   * dropped ones are spellings of `text` rather than capabilities — see
   * {@link PLUGIN_SETTINGS_FIELD_KINDS} for why `number` never round-tripped as a
   * number and why `password` masked a value kept in plaintext.
   */
  const kinds: readonly string[] =
    surface === "settings" ? PLUGIN_SETTINGS_FIELD_KINDS : ["text", "password", "number", "toggle", "select"];
  /*
   * ⚠ **Absence is a default; a *value* this surface does not draw is a
   * substitution.** Omitting `kind` means "an ordinary text field" and is a
   * perfectly good thing for a plugin to do, so it says nothing. Sending
   * `"string"` or `"boolean"` — both real, both from a plugin that shipped — is
   * a field that will not behave as its author wrote it, and that has to be said.
   *
   * ⚠ **`password` on a settings pane takes this path too, and it must.** It is
   * the one substitution here that *looks* like it worked: the field draws, it
   * round-trips, and the only thing missing is the masking its author asked for.
   * Silently downgrading it is how a pane ships believing it hides something.
   */
  const known = (kinds as readonly PluginFieldKind[]).find((one) => one === field.kind);
  if (known === undefined && field.kind !== undefined && field.kind !== null) swap();
  const kind = known ?? "text";
  const key = clip(field.key, PLUGIN_VIEW_LIMITS.short);
  /*
   * ⚠ **A field with no `key` cannot round-trip and never could.** The form
   * submits `{[key]: value}`, so every keyless field collapses onto one entry
   * named `""` — which is what happens when a plugin sends `id` instead, and is
   * indistinguishable on screen from a form that works.
   */
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
