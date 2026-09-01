import { AGENT_IDS, AGENT_LOGIN, DAEMON_ENV_PREFIX, SESSION_SCOPED_ENV } from "../acp/agents.js";
import { SYSTEM_IDS, SYSTEMS } from "../acp/systems.js";
import {
  negotiatePluginApi,
  PLUGIN_API_MIN_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_HOOKS,
  PLUGIN_SCOPES,
  type HarnessContribution,
  type PluginAction,
  type PluginContributions,
  type PluginHook,
  type PluginManifest,
  type PluginScope,
  type SystemContribution,
} from "./protocol.js";

/**
 * `plugin.json`, read the way everything else in this tree reads somebody's JSON:
 * by hand, field by field, with a sentence per refusal.
 *
 * **Pure, and it takes text rather than a path.** That is not tidiness — it is
 * what makes every refusal below reachable from `daemoncheck` with no filesystem
 * at all, which matters because the refusals are the whole value of this file. A
 * validator whose error paths are only reachable by building a real archive is a
 * validator whose error paths are not driven.
 *
 * No zod, like everything else here.
 *
 * The posture throughout is **refuse rather than repair**. A manifest is written
 * once by a person and read forever by a machine, so a field this daemon quietly
 * fixed is a field whose author never learns it was wrong — and the fix is a
 * guess about somebody's intent made at install time on a machine nobody is
 * sitting in front of. The one exception is *absence*: an optional field left out
 * has an obvious meaning and gets it.
 */

export type ManifestRefusalCode =
  | "manifest_unreadable"
  | "manifest_invalid"
  | "plugin_api_too_old"
  | "plugin_api_too_new";

export type ManifestOutcome =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; code: ManifestRefusalCode; message: string };

/*
 * ⚠ **Every bound below is exported for `daemoncheck` and for nothing else —
 * there is no caller.** Nothing outside this file compares a manifest against
 * these. What there was instead was a driver spelling them out again,
 * `"x".repeat(201)` and the string `"name must be 1–64"`, so each number was
 * written down three times — in the comparison, in the refusal sentence, and in
 * the fixture — and moving it moved one of the three. A driver that copies a
 * bound is a driver that goes on asserting the old one, which is why `envNameFor`
 * is pure: `relaycheck` loops over `SETTING_KEYS` instead of listing them.
 *
 * ⚠ **The driver interpolates them now, and that closes the wide gap by opening a
 * narrow one.** Both sides of a derived fixture move together, so a bound that
 * changes value is **invisible** to every case built on it — which is the whole
 * point, and is also why derivation alone is not the assertion. The one failure it
 * cannot see is a comparison that drifts off its own constant by one, so
 * `daemoncheck` sweeps all six at *exactly* their ceiling as well: every existing
 * case is one character past a bound, and a validator refusing one character early
 * passes every one of them silently.
 */

/**
 * How many contributions one plugin may declare.
 *
 * Not a resource bound — these cost nothing to hold. They are a bound on what a
 * plugin may put on *somebody's screen*: eight rows in a session's kebab menu is
 * already more than that menu has ever held, and a plugin able to declare forty
 * would be a plugin able to make the menu unusable for everything else on it.
 */
export const MAX_ACTIONS = 8;
/** How many hosts `net.fetch` may be pointed at. A plugin talks to a service, not to the web. */
export const MAX_NET_HOSTS = 8;

/** How long the name shown wherever this plugin is listed may be. */
export const MAX_NAME_CHARS = 64;

/** How long the sentence under that name may be. A line on a row, not a README. */
export const MAX_DESCRIPTION_CHARS = 200;

/**
 * How long each of the two titles may be — and they are two constants at one
 * value on purpose.
 *
 * ⚠ **A screen title and an action title are different subjects that agree on
 * 40 by coincidence of what fits.** One is drawn once, at the head of a plugin's
 * own page; the other is a row in a session's kebab menu, beside Resume and Stop
 * and beside whatever a second installed plugin called its own — which is the
 * width that is actually under pressure, and `plugin-ui.md` records a single
 * string wrapping that 208px panel to two lines and moving Stop by however long
 * an author's title was. Written as the literal `40` in both places, tightening
 * the menu row is one edit that silently leaves the page alone, and nothing
 * anywhere says the two were ever one decision.
 */
export const MAX_SCREEN_TITLE_CHARS = 40;
export const MAX_ACTION_TITLE_CHARS = 40;

/**
 * How many harnesses and systems one plugin may add.
 *
 * ⚠ **A resource bound, unlike {@link MAX_ACTIONS} one field up, and the two must
 * not be reasoned about together.** An action costs a row in a menu. A *harness*
 * costs a **process** every time `GET /agents/capabilities` is read — that route
 * fans over every harness with `Promise.all` under `MAX_CONCURRENT_ASKS` of 2, and
 * the four built-ins already take 2531 ms overlapped (measured 2026-08-28; per
 * harness 627–2260 ms). So the sweep is roughly `(N + 4) / 2 × 1.3 s`, and the
 * builder opens that route on every visit.
 *
 * ⚠ **And the cost is not only the wait.** A sweep holds both ask slots for its
 * whole length, while `model.complete` and `model.list` deliberately do *not*
 * queue — `MAX_CONCURRENT_ASKS` is a refusal `docs/PLUGINS.md` publishes to plugin
 * authors. So for as long as anybody has the builder open, every plugin model call
 * on the machine answers `model_busy`, and a documented refusal becomes
 * indistinguishable from a broken machine.
 *
 * The per-machine ceilings are `PluginHost`'s, because only it knows what else is
 * installed; these are the per-plugin halves. Two is not a guess about how many
 * harnesses a plugin wants — it is one, plus room for a plugin that ships a CLI
 * under two names — and eight systems is `MAX_NET_HOSTS` beside it.
 */
export const MAX_PLUGIN_HARNESSES = 2;
export const MAX_PLUGIN_SYSTEMS = 8;

/**
 * How long a contributed harness's or system's name may be.
 *
 * Half {@link MAX_NAME_CHARS}, because this one is drawn on a 96px tile beside a
 * glyph rather than on a full-width settings row — and unlike a plugin's own name
 * it is substituted into refusal sentences (`<harness> cannot run <model>.`) that
 * have to stay one line on a phone.
 */
export const MAX_CONTRIBUTED_NAME_CHARS = 32;

/**
 * Bounds on the argv this daemon will **spawn**.
 *
 * ⚠ {@link MAX_ACTIONS}' "not a resource bound, they cost nothing to hold"
 * argument does not reach here and must not be borrowed: every string below
 * becomes a member of a real `execve` argument vector, as this uid.
 */
export const MAX_HARNESS_ARGS = 8;
export const MAX_HARNESS_ARG_CHARS = 64;

/** How many credential slots one contributed harness may offer, and how many model variables it may read. */
export const MAX_HARNESS_ENV_NAMES = 4;
export const MAX_ROUTED_MODEL_ENV = 4;

/** How long the sentence shown when a contributed harness refuses a session may be. */
export const MAX_AUTH_HINT_CHARS = 400;

/**
 * How many models one contributed system may write down, and how long each may be.
 *
 * The id bound is `MAX_MODEL_CHARS` on the routes, restated rather than imported
 * because `server.ts` is not a dependency of this file; the two are compared by
 * `daemoncheck` rather than by a shared constant, for the same reason the archive
 * limits are.
 */
export const MAX_SYSTEM_MODELS = 64;
export const MAX_SYSTEM_MODEL_ID_CHARS = 256;
export const MAX_SYSTEM_MODEL_NAME_CHARS = 64;

/** How long a contributed system's base URL may be. */
export const MAX_BASE_URL_CHARS = 200;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
/** A hostname, lower-case, no scheme, no port, no path. */
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * An address wearing a hostname's shape.
 *
 * ⚠ `HOST` alone accepts `127.0.0.1` — three dots and four labels of digits is a
 * perfectly well-formed name by that pattern, which is how an address literal
 * walked past a check whose refusal string already said "and not an address".
 * The test is the **last** label being all digits, which is the rule that makes a
 * numeric top-level domain impossible and excludes every dotted-quad exactly.
 * IPv6 needs nothing: `HOST` has no colon in it.
 *
 * Refused so that the allowlist somebody approves is a list of *names*. It is not
 * an SSRF defence and `LOCAL_HOST` says why in full.
 */
const ADDRESS = /\.\d+$/;

/**
 * Names that resolve to this machine or to a cloud instance's own metadata.
 *
 * ⚠ **This is a spelling check, not an SSRF defence, and the difference is worth
 * stating because the stronger claim is the one somebody will assume.** A
 * hostname somebody controls can resolve to `127.0.0.1` or to `169.254.169.254`
 * whatever this list says, and re-resolving after the check is the classic
 * rebinding race. What this actually stops is a plugin *declaring* an obviously
 * local target and an operator approving it without reading — which is a
 * mistake, and mistakes are what the scope list is for.
 *
 * The real answer is the one `SECURITY.md` gives: the plugin is a child process
 * running as this uid and can open its own socket to anything. `net.fetch` exists
 * so that a plugin which stays inside the API is *auditable*, not so that one
 * which leaves it is stopped.
 */
const LOCAL_HOST = /(^|\.)(localhost|local|internal|localdomain)$/;

export function parseManifest(text: string): ManifestOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: "manifest_unreadable",
      message: `plugin.json is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "manifest_unreadable", message: "plugin.json must be a JSON object" };
  }
  const source = raw as Record<string, unknown>;

  const id = source["id"];
  if (typeof id !== "string" || !ID.test(id)) {
    return invalid(
      "id must be 1–32 characters of lower-case letters, digits and hyphens, starting with a letter or digit",
    );
  }

  const name = source["name"];
  if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_NAME_CHARS) {
    return invalid(`name must be 1–${MAX_NAME_CHARS} characters`);
  }

  const version = source["version"];
  if (typeof version !== "string" || !VERSION.test(version)) {
    return invalid("version must be three numbers, like 1.2.3");
  }

  const api = source["api"];
  if (typeof api !== "number" || !Number.isInteger(api) || api < 0) {
    return invalid("api must be a whole number");
  }
  const verdict = negotiatePluginApi(api);
  if (verdict === "too_old") {
    return {
      ok: false,
      code: "plugin_api_too_old",
      message: `this plugin is written against plugin API ${api}; this daemon needs ${PLUGIN_API_MIN_VERSION} or newer`,
    };
  }
  if (verdict === "too_new") {
    return {
      ok: false,
      code: "plugin_api_too_new",
      message: `this plugin needs plugin API ${api}; this daemon speaks ${PLUGIN_API_VERSION}. Update the machine`,
    };
  }

  const description = source["description"];
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS)
  ) {
    return invalid(`description must be a string of at most ${MAX_DESCRIPTION_CHARS} characters`);
  }

  const scopes = readScopes(source["scopes"]);
  if (typeof scopes === "string") return invalid(scopes);

  const net = readNet(source["net"], scopes);
  if (typeof net === "string") return invalid(net);

  const contributes = readContributions(source["contributes"], api, scopes);
  if (typeof contributes === "string") return invalid(contributes);

  return {
    ok: true,
    manifest: {
      id,
      name: name.trim(),
      version,
      api,
      description: typeof description === "string" ? description : null,
      scopes,
      net,
      contributes,
    },
  };
}

function invalid(message: string): ManifestOutcome {
  return { ok: false, code: "manifest_invalid", message };
}

function readScopes(raw: unknown): PluginScope[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "scopes must be an array";
  const out: PluginScope[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return "every scope must be a string";
    const found = PLUGIN_SCOPES.find((scope) => scope === entry);
    // Named in the refusal, because the whole list is short and somebody who
    // mistyped one wants to see the ones they could have meant. Never a count in
    // the prose: a number written here is falsified by the next scope added and
    // by nothing else, while the refusal interpolates `PLUGIN_SCOPES` and cannot
    // be wrong about how many there are.
    if (found === undefined) return `unknown scope ${JSON.stringify(entry)}; the scopes are ${PLUGIN_SCOPES.join(", ")}`;
    if (out.includes(found)) return `scope ${JSON.stringify(entry)} is listed twice`;
    out.push(found);
  }
  return out;
}

/** One sentence, two ways to reach it: `net` absent entirely, and `net` present but empty. */
const NET_NEEDS_HOSTS = 'the "net" scope needs a net list naming the hosts it reaches';

function readNet(raw: unknown, scopes: readonly PluginScope[]): string[] | string {
  if (raw === undefined || raw === null) {
    // Declaring `net` and listing nothing is refused rather than treated as "any
    // host": a scope whose allowlist is empty reads, to whoever is approving the
    // install, as a plugin that talks to nowhere. It has to say where.
    return scopes.includes("net") ? NET_NEEDS_HOSTS : [];
  }
  if (!Array.isArray(raw)) return "net must be an array of host names";
  if (raw.length > 0 && !scopes.includes("net")) return 'net lists hosts but the "net" scope is not declared';
  if (raw.length === 0 && scopes.includes("net")) {
    return NET_NEEDS_HOSTS;
  }
  if (raw.length > MAX_NET_HOSTS) return `net may name at most ${MAX_NET_HOSTS} hosts`;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return "every net entry must be a string";
    const host = entry.toLowerCase();
    if (!HOST.test(host) || ADDRESS.test(host)) {
      return `net entry ${JSON.stringify(entry)} must be a host name — no scheme, no port, no path, and not an address`;
    }
    if (LOCAL_HOST.test(host)) return `net entry ${JSON.stringify(entry)} names this machine`;
    if (out.includes(host)) return `net entry ${JSON.stringify(entry)} is listed twice`;
    out.push(host);
  }
  return out;
}

/**
 * The api rung below which a contribution point is refused rather than dropped.
 *
 * ⚠ **This exists because "an older daemon ignores an unknown field" is the wrong
 * model for a contribution, and following it would ship plugins that install and
 * do nothing.** The reader below takes the keys it knows and leaves the rest, so
 * without this test a manifest declaring `4` with a `harnesses` block is accepted
 * everywhere and contributes nowhere — and there is no degraded half of the
 * feature left running, because the harness *is* the plugin. Exported so
 * `daemoncheck` drives the boundary rather than the value.
 */
export const CONTRIBUTION_API = 5;

function readContributions(
  raw: unknown,
  api: number,
  scopes: readonly PluginScope[],
): PluginContributions | string {
  if (raw === undefined || raw === null) {
    // Absence is the one thing repaired rather than refused, per this file's
    // opening rule — and it has to answer the two new keys as well, or a plugin
    // that writes no `contributes` at all becomes a shape nothing else can read.
    return declaredNothing(scopes);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return "contributes must be an object";
  const source = raw as Record<string, unknown>;

  let screen: { title: string } | null = null;
  const rawScreen = source["screen"];
  if (rawScreen !== undefined && rawScreen !== null) {
    if (typeof rawScreen !== "object" || Array.isArray(rawScreen)) return "contributes.screen must be an object";
    const title = (rawScreen as Record<string, unknown>)["title"];
    if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_SCREEN_TITLE_CHARS) {
      return `contributes.screen.title must be 1–${MAX_SCREEN_TITLE_CHARS} characters`;
    }
    screen = { title: title.trim() };
  }

  const rawSettings = source["settings"];
  if (rawSettings !== undefined && typeof rawSettings !== "boolean") return "contributes.settings must be true or false";
  const settings = rawSettings === true;

  const actions = readActions(source["actions"]);
  if (typeof actions === "string") return actions;

  const hooks = readHooks(source["hooks"]);
  if (typeof hooks === "string") return hooks;

  /*
   * ⚠ **Refused above the readers rather than inside them**, so the sentence names
   * the api rather than whichever field happened to be looked at first. Both keys
   * are tested even though only one may be present: a manifest declaring the wrong
   * rung is wrong about the rung, not about the block.
   *
   * ⚠ **On a *non-empty* block, and that is what keeps this function idempotent
   * over its own output.** `parseManifest` normalises an absent `contributes` into
   * one carrying `harnesses: []` and `systems: []`, and
   * `SqlitePluginRecordStore.toRecord` re-validates `manifest_json` through here on
   * **every read** — so a presence test would refuse, on the second read, every
   * plugin this function had itself accepted on the first, and every already
   * installed plugin would vanish from `list()` at the next daemon start. Measured:
   * it took out the whole plugin lifecycle section before anything else noticed.
   * A block that is present and empty declares nothing anyway, so there is nothing
   * the rung could be protecting.
   */
  const adds = (key: string): boolean => {
    const value = source[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  };
  if (api < CONTRIBUTION_API && (adds("harnesses") || adds("systems"))) {
    return `contributes.harnesses and contributes.systems need plugin API ${CONTRIBUTION_API}; this manifest declares ${api}`;
  }

  const harnesses = readHarnesses(source["harnesses"], scopes);
  if (typeof harnesses === "string") return harnesses;

  const systems = readSystems(source["systems"], scopes, harnesses);
  if (typeof systems === "string") return systems;

  return { screen, settings, actions, hooks, harnesses, systems };
}

/** What `contributes` absent means, which still has to answer the scope gate. */
function declaredNothing(scopes: readonly PluginScope[]): PluginContributions | string {
  const missing = SCOPE_NEEDS_BLOCK.find((one) => scopes.includes(one.scope));
  if (missing !== undefined) return missing.sentence;
  return { screen: null, settings: false, actions: [], hooks: [], harnesses: [], systems: [] };
}

/*
 * ⚠ **Each of the two is a biconditional, and both halves are the `net` rule.**
 * A scope with an empty block reads, to whoever is approving the install, as a
 * plugin that adds nothing — so it has to say what. A block with no scope is the
 * other direction and matters more: the scope list is the only place the consent
 * screen puts a capability that a *browser older than this daemon* can still
 * render, so a contribution smuggled in under no scope is one that older client
 * cannot mention at all.
 */
const SCOPE_NEEDS_BLOCK: readonly { scope: PluginScope; sentence: string }[] = [
  { scope: "harness", sentence: 'the "harness" scope needs contributes.harnesses to name the agents it adds' },
  { scope: "system", sentence: 'the "system" scope needs contributes.systems to name the providers it adds' },
];

function readActions(raw: unknown): PluginAction[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "contributes.actions must be an array";
  if (raw.length > MAX_ACTIONS) return `a plugin may contribute at most ${MAX_ACTIONS} actions`;
  const out: PluginAction[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "every action must be an object";
    const action = entry as Record<string, unknown>;
    const id = action["id"];
    if (typeof id !== "string" || !ID.test(id)) {
      return "every action needs an id of 1–32 lower-case letters, digits and hyphens";
    }
    if (out.some((one) => one.id === id)) return `action ${JSON.stringify(id)} is declared twice`;
    const title = action["title"];
    if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_ACTION_TITLE_CHARS) {
      return `action ${JSON.stringify(id)} needs a title of 1–${MAX_ACTION_TITLE_CHARS} characters`;
    }
    const on = action["on"];
    if (on !== "session" && on !== "screen") {
      return `action ${JSON.stringify(id)} must be on "session" or on "screen"`;
    }
    out.push({ id, title: title.trim(), on });
  }
  return out;
}

function readHooks(raw: unknown): PluginHook[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "contributes.hooks must be an array";
  const out: PluginHook[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return "every hook must be a string";
    const found = PLUGIN_HOOKS.find((hook) => hook === entry);
    if (found === undefined) return `unknown hook ${JSON.stringify(entry)}; the hooks are ${PLUGIN_HOOKS.join(", ")}`;
    if (out.includes(found)) return `hook ${JSON.stringify(entry)} is listed twice`;
    out.push(found);
  }
  return out;
}


/* ── Contributed harnesses and systems ───────────────────────────────────── */

/**
 * The id this daemon uses for something a plugin added.
 *
 * ⚠ **Namespaced, and the colon is doing three jobs rather than one.** A built-in
 * id is `[a-z0-9-]+` with no separator, so `<pluginId>:<localId>` cannot collide
 * with `claude` or `openrouter` **by construction** rather than by a check that
 * somebody has to remember to run; two plugins cannot collide with each other,
 * since `plugins.id` is a primary key; and — the load-bearing one — the shape is
 * recognisable *without a registry*, which is what lets `fromRow` accept a
 * persisted row naming a harness whose plugin is switched off, instead of dropping
 * somebody's conversation for the length of an outage.
 *
 * An author never writes it. A manifest names local ids and this is applied on the
 * way out, in `contributions.ts`.
 */
export function contributedId(pluginId: string, localId: string): string {
  return `${pluginId}:${localId}`;
}

/** The `<pluginId>` half, or `null` for anything that is not a contributed id. */
export function pluginOfContributedId(id: string): string | null {
  const cut = id.indexOf(":");
  if (cut <= 0) return null;
  return isContributedId(id) ? id.slice(0, cut) : null;
}

/**
 * Whether this *could* be an id a plugin contributed — a shape test, never a
 * membership test.
 *
 * ⚠ **The distinction is the whole reason this is exported, and getting it
 * backwards costs conversations.** Membership is asked where nothing has been
 * created yet — `POST /sessions`, `POST /custom-agents` — so a refusal is free and
 * a worktree is never made for a harness that cannot run. Shape is asked where the
 * row *is* the memory: `fromRow` and `readCustomAgent` run at boot, before
 * anything is on screen, and a membership test there would delete every session on
 * a harness whose plugin somebody had switched off an hour ago. That asymmetry is
 * `custom_agents.harness` (validated) against `agent_strip.ref` (never validated),
 * applied to the case that sits between them: `resolveAgent` refuses at launch,
 * with a sentence, and the conversation is still there when the plugin comes back.
 */
export function isContributedId(id: string): boolean {
  const cut = id.indexOf(":");
  if (cut <= 0 || cut === id.length - 1) return false;
  return ID.test(id.slice(0, cut)) && ID.test(id.slice(cut + 1));
}

/** A variable name a CLI could plausibly read. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A program name, not a path: no slash, no backslash, no `..`. */
const COMMAND = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An HTTP field name. Lower-case, because `routingHeaders` uses it as written. */
const HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** What may precede a secret in a header value, with at most one trailing space. */
const HEADER_PREFIX = /^[A-Za-z0-9._~+/-]{0,32} ?$/;

/**
 * Programs a contributed harness may not name.
 *
 * ⚠ **Not tidiness: naming `claude` here would let a plugin drive the operator's
 * own signed-in CLI**, with its credentials, under a row the consent screen
 * labels with the plugin's name — and the person approving it would be reading a
 * command line that is true and a heading that is a lie. `script` is on the list
 * because it is what `hostLoginArgs` allocates a pty with.
 */
const RESERVED_COMMANDS: readonly string[] = [...AGENT_IDS.map((id) => AGENT_LOGIN[id].command), "script"];

/**
 * Variable names a manifest may not claim.
 *
 * Three sets, and they are three different failures:
 *
 *   - **`SESSION_SCOPED_ENV`** — `LocalRuntime.launch` spreads the routed-model
 *     environment *last*, so a manifest naming `CLAUDE_CODE_SESSION_ID` would
 *     restore exactly the variable `agentEnv()` had just deleted, and
 *     `CODEX_SANDBOX_NETWORK_DISABLED` would take the network away from an agent
 *     nobody had confined.
 *   - **every built-in's credential slot, and every system's `keyEnv`** — this is
 *     the sharpest one and it is not hygiene. `envNames` decides which variable
 *     names a *person* is invited to paste a secret into, under a card headed with
 *     the plugin's own name. `CLAUDE_CODE_OAUTH_TOKEN` there is a phishing box.
 *   - **every built-in's `executableEnv`** — `resolveLoginBinary` reads it for
 *     every agent, so a manifest naming `CLAUDE_CODE_EXECUTABLE` would redirect
 *     which binary somebody else's login drives.
 *
 * `REEMOAT_*` is tested separately, as a prefix, for `DAEMON_ENV_PREFIX`'s own
 * reason: the failure mode of a list is the variable nobody thought of.
 *
 * ⚠ **This list, and {@link RESERVED_COMMANDS} above it, make `parseManifest`
 * depend on the built-in tables — and `SqlitePluginRecordStore.toRecord` runs this
 * function over every stored manifest on every read.** So the release that adds a
 * fifth built-in reading `GEMINI_API_KEY` makes a plugin that had claimed that slot
 * unreadable, and at the next daemon start it drops out of `records.list()`
 * entirely: its harness leaves every catalogue and its sessions refuse. Two things
 * bound the damage rather than one. `doRemove` sweeps credentials by **prefix**, so
 * an uninstall still reaches its keys with no manifest at all; and nothing is
 * deleted by the drop itself — the row, the tree and the data all stay, and the
 * plugin comes back the moment its manifest is readable again. What is owed on the
 * day a built-in is added is a look at what the fleet has installed, which is the
 * same look `RELEASING.md` already asks for before a floor is raised.
 *
 * ⚠ **And there is a *second* `parseManifest`, in the plugin catalogue, which
 * cannot follow this list at all — which makes the spread above the one thing here
 * that drifts with no declaration changing on either side.** That service mirrors
 * this file by hand and has no `src/acp` to spread from, so it can only hold a
 * literal. The failure is quiet in both directions and lands on somebody else: the
 * day a fifth built-in is added that reads `GEMINI_API_KEY`, this list grows by
 * derivation, the catalogue's does not, and it happily publishes a plugin claiming
 * that slot — which every daemon then refuses at install, about a plugin the market
 * said was fine.
 *
 * Deriving is still right *here*: a literal would drift against `AGENT_LOGIN` in
 * this same repository, which is the nearer and likelier mistake. What the
 * derivation costs is that the check has to live where both sides are visible, and
 * it does — the catalogue's own driver imports these two `acp` modules directly and
 * compares in both directions, degrading to a printed skip where this repository is
 * not checked out beside it. Adding a built-in agent is therefore a change in two
 * repositories, and this paragraph is the only place that says so.
 */
const RESERVED_ENV_NAMES: readonly string[] = [
  ...SESSION_SCOPED_ENV,
  ...AGENT_IDS.flatMap((id) => AGENT_LOGIN[id].envNames),
  ...AGENT_IDS.map((id) => AGENT_LOGIN[id].executableEnv).filter((one): one is string => one !== null),
  ...SYSTEM_IDS.map((id) => SYSTEMS[id].keyEnv).filter((one): one is string => one !== null),
];

function readEnvNames(raw: unknown, what: string, cap: number): string[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${what} must be an array of variable names`;
  if (raw.length > cap) return `${what} may name at most ${cap} variables`;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !ENV_NAME.test(entry)) {
      return `${what} entry ${JSON.stringify(entry)} must be a variable name in capitals, like MY_API_KEY`;
    }
    if (entry.startsWith(DAEMON_ENV_PREFIX)) return `${what} may not name ${JSON.stringify(entry)}: ${DAEMON_ENV_PREFIX}* belongs to this daemon`;
    if (RESERVED_ENV_NAMES.includes(entry)) return `${what} may not name ${JSON.stringify(entry)}: another agent on this machine reads it`;
    if (out.includes(entry)) return `${what} names ${JSON.stringify(entry)} twice`;
    out.push(entry);
  }
  return out;
}

function readHarnesses(raw: unknown, scopes: readonly PluginScope[]): HarnessContribution[] | string {
  if (raw === undefined || raw === null) {
    return scopes.includes("harness") ? SCOPE_NEEDS_BLOCK[0]!.sentence : [];
  }
  if (!Array.isArray(raw)) return "contributes.harnesses must be an array";
  if (raw.length > 0 && !scopes.includes("harness")) return 'contributes.harnesses adds agents but the "harness" scope is not declared';
  if (raw.length === 0 && scopes.includes("harness")) return SCOPE_NEEDS_BLOCK[0]!.sentence;
  if (raw.length > MAX_PLUGIN_HARNESSES) return `a plugin may add at most ${MAX_PLUGIN_HARNESSES} harnesses`;

  const out: HarnessContribution[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "every harness must be an object";
    const one = entry as Record<string, unknown>;

    const id = one["id"];
    if (typeof id !== "string" || !ID.test(id)) {
      return "every harness needs an id of 1–32 lower-case letters, digits and hyphens";
    }
    if (out.some((seen) => seen.id === id)) return `harness ${JSON.stringify(id)} is declared twice`;

    const name = one["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_CONTRIBUTED_NAME_CHARS) {
      return `harness ${JSON.stringify(id)} needs a name of 1–${MAX_CONTRIBUTED_NAME_CHARS} characters`;
    }

    const command = one["command"];
    if (typeof command !== "string" || !COMMAND.test(command)) {
      return `harness ${JSON.stringify(id)} needs a command that is a program name — no slash, no path, no arguments`;
    }
    if (RESERVED_COMMANDS.includes(command)) {
      return `harness ${JSON.stringify(id)} may not name ${JSON.stringify(command)}: this machine already runs that program as an agent of its own`;
    }

    const args = one["args"];
    if (args !== undefined && args !== null && !Array.isArray(args)) return `harness ${JSON.stringify(id)} args must be an array`;
    const argv: string[] = [];
    for (const arg of Array.isArray(args) ? args : []) {
      if (typeof arg !== "string" || arg.length === 0 || arg.length > MAX_HARNESS_ARG_CHARS) {
        return `harness ${JSON.stringify(id)} has an argument that is not a string of 1–${MAX_HARNESS_ARG_CHARS} characters`;
      }
      argv.push(arg);
    }
    if (argv.length > MAX_HARNESS_ARGS) return `harness ${JSON.stringify(id)} may pass at most ${MAX_HARNESS_ARGS} arguments`;
    /*
     * ⚠ **The whole argv, because checking only `argv[0]` made the rule above true
     * of one word rather than of the command line.** `{"command": "env", "args":
     * ["claude"]}` and `{"command": "sh", "args": ["-c", "exec claude"]}` both walk
     * past a check on the program name and spawn the operator's *signed-in* CLI,
     * with its credentials, under a row the consent screen labels with the plugin's
     * name — which is verbatim what `RESERVED_COMMANDS` says it exists to prevent.
     *
     * ⚠ **Word by word rather than by substring**, so `--profile=codex` is left
     * alone: this is about a program being *invoked*, and a flag that happens to
     * contain a name is not that. It cannot be complete — nothing here can stop a
     * wrapper that spells the name some other way — which is why the argv is on the
     * consent card in full and in `consentGap`. What it closes is the one shape a
     * reader of that card would not think to look for.
     */
    const reserved = argv.flatMap((one) => one.split(/[\s=]+/)).find((word) => RESERVED_COMMANDS.includes(word));
    if (reserved !== undefined) {
      return `harness ${JSON.stringify(id)} may not pass ${JSON.stringify(reserved)} as an argument: this machine already runs that program as an agent of its own`;
    }

    const envNames = readEnvNames(one["envNames"], `harness ${JSON.stringify(id)} envNames`, MAX_HARNESS_ENV_NAMES);
    if (typeof envNames === "string") return envNames;

    const routedModelEnv = readEnvNames(
      one["routedModelEnv"],
      `harness ${JSON.stringify(id)} routedModelEnv`,
      MAX_ROUTED_MODEL_ENV,
    );
    if (typeof routedModelEnv === "string") return routedModelEnv;

    const authHint = one["authHint"];
    if (
      authHint !== undefined &&
      authHint !== null &&
      (typeof authHint !== "string" || authHint.length > MAX_AUTH_HINT_CHARS)
    ) {
      return `harness ${JSON.stringify(id)} authHint must be a string of at most ${MAX_AUTH_HINT_CHARS} characters`;
    }

    out.push({
      id,
      name: name.trim(),
      command,
      args: argv,
      envNames,
      routedModelEnv,
      authHint: typeof authHint === "string" && authHint.trim().length > 0 ? authHint.trim() : null,
    });
  }
  return out;
}

/**
 * Addresses that are never an inference endpoint, whatever scheme they wear.
 *
 * ⚠ **Refused under `https` as well as under `http`, unlike everything else in
 * {@link isPrivateHost}.** `169.254.169.254` and its IPv6 sibling are cloud
 * instance metadata — the classic target — and a base URL pointed at one is not a
 * self-hosted model somebody stood up, it is a request for this daemon to sign a
 * call to its own host's credentials service with a key the operator pasted.
 * Nothing legitimate is lost: the whole of `169.254/16` is link-local.
 */
function isMetadataHost(host: string): boolean {
  const four = ipv4(host);
  if (four !== null) return four[0] === 169 && four[1] === 254;
  /*
   * ⚠ **By name as well, and the names are the arm that was missing.** GCP's
   * metadata service is `metadata.google.internal`, which resolves to
   * `169.254.169.254` — and `isPrivateHost` below returns `true` for *anything*
   * ending `.internal`, so without this line the `http` allowance and the metadata
   * refusal both failed on the same string: a manifest could point a base URL at
   * the host's own credentials service, in the clear, and be accepted. This file
   * already disagreed with itself about it — `LOCAL_HOST` refuses `internal` in a
   * `net` allowlist on exactly those grounds.
   */
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (METADATA_NAMES.has(bare) || bare.endsWith(".metadata.google.internal")) return true;
  /*
   * And the IPv4-mapped spelling of the address, which `URL` serialises as
   * `[::ffff:a9fe:a9fe]` rather than as a dotted quad — so `ipv4` above answers
   * `null` for it and the numeric arm never sees it.
   */
  return bare === "fd00:ec2::254" || bare.startsWith("::ffff:a9fe:") || bare.startsWith("::ffff:169.254.");
}

/**
 * Names that are an instance metadata service rather than a model.
 *
 * A spelling check like {@link LOCAL_HOST} and not an SSRF defence — a hostname
 * somebody controls resolves wherever they like. What it stops is a manifest
 * *declaring* one of the two names anybody would actually reach for, on a screen
 * where an operator is being asked to approve an endpoint.
 */
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog"]);

/** The four octets of a dotted-quad, or `null` for anything else. */
function ipv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/**
 * Whether this host is on the machine or on its own network.
 *
 * ⚠ **This is the opposite decision from `LOCAL_HOST` and `ADDRESS` forty lines
 * up, in the same file, and the difference is which key is at stake.** Those two
 * refuse a local target in a plugin's `net` allowlist, where the request is one the
 * **plugin's own process** composes and a local address is a mistake somebody is
 * approving without reading. A system's `baseUrl` is where the **operator's own
 * pasted key** goes to a model they chose by name — and a private address there is
 * the one case where they plainly mean it, because Ollama, vLLM and LM Studio are
 * exactly this and nothing else in the product reaches them.
 *
 * It is still not an SSRF defence and could not be: a name somebody controls
 * resolves wherever they like, and re-resolving after the check is the rebinding
 * race. What it decides is narrower and honest — whether `http` is allowed at all,
 * which is a question about *this operator's own network* rather than about trust.
 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  const four = ipv4(host);
  if (four !== null) {
    if (four[0] === 127) return true;
    if (four[0] === 10) return true;
    if (four[0] === 172 && four[1] >= 16 && four[1] <= 31) return true;
    if (four[0] === 192 && four[1] === 168) return true;
    // 169.254/16 is deliberately absent: link-local is refused outright above.
    return false;
  }
  /*
   * ⚠ **`URL.hostname` keeps the brackets on an IPv6 literal** — measured:
   * `new URL("http://[::1]:8080/").hostname` is `"[::1]"`, not `"::1"` — so a
   * comparison written against the bare form silently matches nothing and every
   * IPv6 loopback falls through to "not private", i.e. `http` refused for the one
   * address that is most obviously local.
   */
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  return false;
}

/**
 * A base URL, normalised — or a sentence.
 *
 * `https` anywhere; `http` **only** to somewhere {@link isPrivateHost} recognises,
 * because a key sent in the clear across a network this daemon cannot characterise
 * is not a trade anybody can consent to from a phone. The consent screen draws that
 * case on its own line.
 */
function readBaseUrl(raw: unknown, what: string): string | null | string[] {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BASE_URL_CHARS) {
    return [`${what} baseUrl must be a URL of at most ${MAX_BASE_URL_CHARS} characters`];
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [`${what} baseUrl is not a URL`];
  }
  if (url.username !== "" || url.password !== "") return [`${what} baseUrl may not carry a user name or a password`];
  if (url.hash !== "" || url.search !== "") return [`${what} baseUrl may not carry a query or a fragment`];
  const host = url.hostname.toLowerCase();
  if (isMetadataHost(host)) return [`${what} baseUrl names this host's own metadata service`];
  if (url.protocol === "http:") {
    if (!isPrivateHost(host)) {
      return [`${what} baseUrl must be https, unless it names this machine or your own network`];
    }
  } else if (url.protocol !== "https:") {
    return [`${what} baseUrl must be https`];
  }
  // Normalised here rather than at every reader: what is compared by `consentGap`
  // and what is stored have to be the same string, or the alarm cries wolf on a
  // trailing slash.
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function readSystems(
  raw: unknown,
  scopes: readonly PluginScope[],
  harnesses: readonly HarnessContribution[],
): SystemContribution[] | string {
  if (raw === undefined || raw === null) {
    return scopes.includes("system") ? SCOPE_NEEDS_BLOCK[1]!.sentence : [];
  }
  if (!Array.isArray(raw)) return "contributes.systems must be an array";
  if (raw.length > 0 && !scopes.includes("system")) return 'contributes.systems adds providers but the "system" scope is not declared';
  if (raw.length === 0 && scopes.includes("system")) return SCOPE_NEEDS_BLOCK[1]!.sentence;
  if (raw.length > MAX_PLUGIN_SYSTEMS) return `a plugin may add at most ${MAX_PLUGIN_SYSTEMS} providers`;

  const own = harnesses.map((one) => one.id);
  const out: SystemContribution[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "every system must be an object";
    const one = entry as Record<string, unknown>;

    const id = one["id"];
    if (typeof id !== "string" || !ID.test(id)) {
      return "every system needs an id of 1–32 lower-case letters, digits and hyphens";
    }
    const what = `system ${JSON.stringify(id)}`;
    if (out.some((seen) => seen.id === id)) return `${what} is declared twice`;

    const name = one["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_CONTRIBUTED_NAME_CHARS) {
      return `${what} needs a name of 1–${MAX_CONTRIBUTED_NAME_CHARS} characters`;
    }

    /*
     * ⚠ **The closed pair, never ACP's open union.** `SystemApiType` is documented
     * as the subset this daemon knows how to *configure*; a manifest naming
     * `"vertex"` would pass `routing.supported.includes` for claude and reach
     * `providers/set` as a shape nothing here has ever driven.
     */
    const apiType = one["apiType"];
    if (apiType !== "anthropic" && apiType !== "openai") {
      return `${what} apiType must be "anthropic" or "openai"`;
    }

    const baseUrlRead = readBaseUrl(one["baseUrl"], what);
    if (Array.isArray(baseUrlRead)) return baseUrlRead[0]!;
    const baseUrl = baseUrlRead;

    const nativeHarness = readOwnHarness(one["nativeHarness"], own, `${what} nativeHarness`);
    if (typeof nativeHarness === "object" && nativeHarness !== null) return nativeHarness.error;
    const loginVia = readOwnHarness(one["loginVia"], own, `${what} loginVia`);
    if (typeof loginVia === "object" && loginVia !== null) return loginVia.error;

    const authHeaderRaw = one["authHeader"];
    let authHeader: { name: string; prefix: string } | null = null;
    if (authHeaderRaw !== undefined && authHeaderRaw !== null) {
      if (typeof authHeaderRaw !== "object" || Array.isArray(authHeaderRaw)) return `${what} authHeader must be an object`;
      const header = authHeaderRaw as Record<string, unknown>;
      const headerName = header["name"];
      /*
       * ⚠ **`routingHeaders` builds `{[name]: prefix + secret}` and hands it
       * straight to `providers/set`.** A CR or an LF in either half is header
       * injection into whatever the adapter does with the pair, so both are
       * allow-listed rather than merely length-bounded.
       */
      if (typeof headerName !== "string" || !HEADER_NAME.test(headerName)) {
        return `${what} authHeader.name must be a lower-case header name, like authorization`;
      }
      const prefix = header["prefix"];
      if (prefix !== undefined && prefix !== null && (typeof prefix !== "string" || !HEADER_PREFIX.test(prefix))) {
        return `${what} authHeader.prefix must be a short word, like "Bearer "`;
      }
      authHeader = { name: headerName, prefix: typeof prefix === "string" ? prefix : "" };
    }

    const models = readSystemModels(one["models"], what);
    if (typeof models === "string") return models;

    const nativeModelPrefix = one["nativeModelPrefix"];
    if (
      nativeModelPrefix !== undefined &&
      nativeModelPrefix !== null &&
      (typeof nativeModelPrefix !== "string" || nativeModelPrefix.length === 0 || nativeModelPrefix.length > 32)
    ) {
      return `${what} nativeModelPrefix must be a short string, like "acme/"`;
    }

    const keyEnvRead = readEnvNames(one["keyEnv"] === undefined || one["keyEnv"] === null ? [] : [one["keyEnv"]], `${what} keyEnv`, 1);
    if (typeof keyEnvRead === "string") return keyEnvRead;
    const keyEnv = keyEnvRead[0] ?? null;

    /*
     * The four rules that keep a row from being a control nobody can spend, each
     * of which `daemoncheck` already sweeps the built-in table for.
     */
    if (baseUrl === null && nativeHarness === null) {
      return `${what} has no baseUrl, so it needs a nativeHarness — otherwise nothing on this machine could ever reach it`;
    }
    if (baseUrl === null && loginVia === null) {
      return `${what} has no baseUrl, so it needs a loginVia — otherwise its key box would store a secret and never send it`;
    }
    if (baseUrl !== null && authHeader === null) {
      return `${what} has a baseUrl, so it needs an authHeader saying how its key is sent`;
    }
    if (baseUrl === null && authHeader !== null) {
      return `${what} has an authHeader but no baseUrl, so there is nowhere to send it`;
    }
    if (nativeModelPrefix !== undefined && nativeModelPrefix !== null && nativeHarness === null) {
      return `${what} nativeModelPrefix says how its own harness spells a model, so it needs a nativeHarness`;
    }
    if (keyEnv !== null && nativeHarness === null) {
      return `${what} keyEnv names a variable its own harness reads, so it needs a nativeHarness`;
    }
    /*
     * ⚠ **And it has to be a variable that harness actually reads**, which is the
     * property `daemoncheck` already sweeps the built-in table for. `keyEnv` is
     * what lets `systemSecretFor` answer "there is a key for this system" from the
     * *harness's* credential store — one account, one box — so a name the harness
     * never declared makes that borrow silently impossible and puts an empty
     * second box under a second heading, which is the exact trap that field exists
     * to close.
     */
    if (keyEnv !== null && !(harnesses.find((one) => one.id === nativeHarness)?.envNames.includes(keyEnv) ?? false)) {
      return `${what} keyEnv names ${JSON.stringify(keyEnv)}, which harness ${JSON.stringify(nativeHarness)} does not read`;
    }
    if (baseUrl !== null && nativeHarness === null && models.length === 0) {
      return `${what} is reached by routing and has no harness of its own, so it has to name at least one model`;
    }

    out.push({
      id,
      name: name.trim(),
      apiType,
      baseUrl,
      authHeader,
      models,
      nativeHarness: typeof nativeHarness === "string" ? nativeHarness : null,
      loginVia: typeof loginVia === "string" ? loginVia : null,
      nativeModelPrefix: typeof nativeModelPrefix === "string" ? nativeModelPrefix : null,
      keyEnv,
    });
  }
  return out;
}

/**
 * A harness id this same plugin contributes, `null`, or a refusal.
 *
 * ⚠ **Only its own, and this is where the "two spellings are the same models"
 * assertion is refused.** A contributed system naming a *built-in* would put
 * "Sign in to Claude Code" under a heading its author chose — and, through
 * `nativeModelPrefix`, would assert that a vendor's two model lists relate, which
 * is exactly the equivalence Q3.488 refuses to make without evidence nothing here
 * could have.
 */
function readOwnHarness(raw: unknown, own: readonly string[], what: string): string | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return { error: `${what} must be the id of a harness this plugin adds` };
  if (!own.includes(raw)) {
    return { error: `${what} names ${JSON.stringify(raw)}, which is not a harness this plugin adds` };
  }
  return raw;
}

function readSystemModels(raw: unknown, what: string): { id: string; name: string }[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${what} models must be an array`;
  if (raw.length > MAX_SYSTEM_MODELS) return `${what} may name at most ${MAX_SYSTEM_MODELS} models`;
  const out: { id: string; name: string }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return `${what} models must each be an object`;
    const model = entry as Record<string, unknown>;
    const id = model["id"];
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_SYSTEM_MODEL_ID_CHARS) {
      return `${what} has a model with no id, or one longer than ${MAX_SYSTEM_MODEL_ID_CHARS} characters`;
    }
    const name = model["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_SYSTEM_MODEL_NAME_CHARS) {
      return `${what} model ${JSON.stringify(id)} needs a name of 1–${MAX_SYSTEM_MODEL_NAME_CHARS} characters`;
    }
    if (out.some((seen) => seen.id === id)) return `${what} names model ${JSON.stringify(id)} twice`;
    out.push({ id, name: name.trim() });
  }
  return out;
}
