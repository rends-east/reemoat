import {
  negotiatePluginApi,
  PLUGIN_API_MIN_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_HOOKS,
  PLUGIN_SCOPES,
  type PluginAction,
  type PluginContributions,
  type PluginHook,
  type PluginManifest,
  type PluginScope,
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

/**
 * How many contributions one plugin may declare.
 *
 * Not a resource bound — these cost nothing to hold. They are a bound on what a
 * plugin may put on *somebody's screen*: eight rows in a session's kebab menu is
 * already more than that menu has ever held, and a plugin able to declare forty
 * would be a plugin able to make the menu unusable for everything else on it.
 */
const MAX_ACTIONS = 8;
/** How many hosts `net.fetch` may be pointed at. A plugin talks to a service, not to the web. */
const MAX_NET_HOSTS = 8;

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
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 64) {
    return invalid("name must be 1–64 characters");
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
  if (description !== undefined && description !== null && (typeof description !== "string" || description.length > 200)) {
    return invalid("description must be a string of at most 200 characters");
  }

  const scopes = readScopes(source["scopes"]);
  if (typeof scopes === "string") return invalid(scopes);

  const net = readNet(source["net"], scopes);
  if (typeof net === "string") return invalid(net);

  const contributes = readContributions(source["contributes"]);
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

function readNet(raw: unknown, scopes: readonly PluginScope[]): string[] | string {
  if (raw === undefined || raw === null) {
    // Declaring `net` and listing nothing is refused rather than treated as "any
    // host": a scope whose allowlist is empty reads, to whoever is approving the
    // install, as a plugin that talks to nowhere. It has to say where.
    return scopes.includes("net") ? 'the "net" scope needs a net list naming the hosts it reaches' : [];
  }
  if (!Array.isArray(raw)) return "net must be an array of host names";
  if (raw.length > 0 && !scopes.includes("net")) return 'net lists hosts but the "net" scope is not declared';
  if (raw.length === 0 && scopes.includes("net")) {
    return 'the "net" scope needs a net list naming the hosts it reaches';
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

function readContributions(raw: unknown): PluginContributions | string {
  if (raw === undefined || raw === null) {
    return { screen: null, settings: false, actions: [], hooks: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return "contributes must be an object";
  const source = raw as Record<string, unknown>;

  let screen: { title: string } | null = null;
  const rawScreen = source["screen"];
  if (rawScreen !== undefined && rawScreen !== null) {
    if (typeof rawScreen !== "object" || Array.isArray(rawScreen)) return "contributes.screen must be an object";
    const title = (rawScreen as Record<string, unknown>)["title"];
    if (typeof title !== "string" || title.trim().length === 0 || title.length > 40) {
      return "contributes.screen.title must be 1–40 characters";
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

  return { screen, settings, actions, hooks };
}

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
    if (typeof title !== "string" || title.trim().length === 0 || title.length > 40) {
      return `action ${JSON.stringify(id)} needs a title of 1–40 characters`;
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
