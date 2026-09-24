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

// plugin.json, parsed from text so daemoncheck reaches every refusal. Refuse rather than repair; only an absent optional field gets a default.

export type ManifestRefusalCode =
  | "manifest_unreadable"
  | "manifest_invalid"
  | "plugin_api_too_old"
  | "plugin_api_too_new";

export type ManifestOutcome =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; code: ManifestRefusalCode; message: string };

// The bounds are exported only so daemoncheck derives its fixtures from them.

/** Bounds what a plugin may put on screen, not a resource. */
export const MAX_ACTIONS = 8;
/** How many hosts `net.fetch` may be pointed at. A plugin talks to a service, not to the web. */
export const MAX_NET_HOSTS = 8;

export const MAX_NAME_CHARS = 64;

export const MAX_DESCRIPTION_CHARS = 200;

/** Two constants at one value on purpose: the page title and the menu-row title are separate decisions. */
export const MAX_SCREEN_TITLE_CHARS = 40;
export const MAX_ACTION_TITLE_CHARS = 40;

/** A resource bound: each harness costs a process on every capabilities sweep. The per-machine ceilings are PluginHost's. */
export const MAX_PLUGIN_HARNESSES = 2;
export const MAX_PLUGIN_SYSTEMS = 8;

export const MAX_CONTRIBUTED_NAME_CHARS = 32;

/** Every string here becomes a real execve argument, run as this uid. */
export const MAX_HARNESS_ARGS = 8;
export const MAX_HARNESS_ARG_CHARS = 64;

/** How many credential slots one contributed harness may offer, and how many model variables it may read. */
export const MAX_HARNESS_ENV_NAMES = 4;
export const MAX_ROUTED_MODEL_ENV = 4;

export const MAX_AUTH_HINT_CHARS = 400;

/** The id bound restates MAX_MODEL_CHARS from the routes; daemoncheck compares the two. */
export const MAX_SYSTEM_MODELS = 64;
export const MAX_SYSTEM_MODEL_ID_CHARS = 256;
export const MAX_SYSTEM_MODEL_NAME_CHARS = 64;

export const MAX_BASE_URL_CHARS = 200;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
/** A hostname, lower-case, no scheme, no port, no path. */
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** HOST alone accepts a dotted quad; an all-digit last label is an address. */
const ADDRESS = /\.\d+$/;

/** A spelling check, not an SSRF defence: the plugin runs as this uid and can open any socket. */
const LOCAL_HOST = /(^|\.)(localhost|local|internal|localdomain)$/;

export function parseManifest(text: string, options: { presenting?: boolean } = {}): ManifestOutcome {
  // presenting false (a stored row being reloaded) relaxes only the refusals that protect a screen; everything bounding what the plugin can do stays strict.
  const presenting = options.presenting ?? true;
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
  if (presenting && CONTROL_CHARS.test(name)) {
    return invalid("name may not carry control or formatting characters");
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
  if (presenting && typeof description === "string" && CONTROL_CHARS.test(description)) {
    return invalid("description may not carry control or formatting characters");
  }

  const scopes = readScopes(source["scopes"]);
  if (typeof scopes === "string") return invalid(scopes);

  const net = readNet(source["net"], scopes);
  if (typeof net === "string") return invalid(net);

  const contributes = readContributions(source["contributes"], api, scopes, presenting);
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
    if (found === undefined) return `unknown scope ${JSON.stringify(entry)}; the scopes are ${PLUGIN_SCOPES.join(", ")}`;
    if (out.includes(found)) return `scope ${JSON.stringify(entry)} is listed twice`;
    out.push(found);
  }
  return out;
}

const NET_NEEDS_HOSTS = 'the "net" scope needs a net list naming the hosts it reaches';

function readNet(raw: unknown, scopes: readonly PluginScope[]): string[] | string {
  if (raw === undefined || raw === null) {
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

/** Below this api a contributions block is refused rather than ignored, since the harness is the plugin. */
export const CONTRIBUTION_API = 5;

function readContributions(
  raw: unknown,
  api: number,
  scopes: readonly PluginScope[],
  presenting: boolean,
): PluginContributions | string {
  if (raw === undefined || raw === null) {
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

  // Tests a non-empty block, not presence: stored manifests are re-validated on every read with empty arrays normalised in.
  const adds = (key: string): boolean => {
    const value = source[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  };
  if (api < CONTRIBUTION_API && (adds("harnesses") || adds("systems"))) {
    return `contributes.harnesses and contributes.systems need plugin API ${CONTRIBUTION_API}; this manifest declares ${api}`;
  }

  const harnesses = readHarnesses(source["harnesses"], scopes, presenting);
  if (typeof harnesses === "string") return harnesses;

  const systems = readSystems(source["systems"], scopes, harnesses, presenting);
  if (typeof systems === "string") return systems;

  return { screen, settings, actions, hooks, harnesses, systems };
}

function declaredNothing(scopes: readonly PluginScope[]): PluginContributions | string {
  const missing = SCOPE_NEEDS_BLOCK.find((one) => scopes.includes(one.scope));
  if (missing !== undefined) return missing.sentence;
  return { screen: null, settings: false, actions: [], hooks: [], harnesses: [], systems: [] };
}

// Biconditional, like net: a block with no scope would be invisible to an older consent screen.
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


/** The colon keeps a contributed id from colliding with a built-in and makes its shape recognisable with no registry. */
export function contributedId(pluginId: string, localId: string): string {
  return `${pluginId}:${localId}`;
}

/** A shape test, never membership: a stored row must survive its plugin being switched off. */
export function isContributedId(id: string): boolean {
  const cut = id.indexOf(":");
  if (cut <= 0 || cut === id.length - 1) return false;
  return ID.test(id.slice(0, cut)) && ID.test(id.slice(cut + 1));
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A program name, not a path: no slash, no backslash, no `..`. */
const COMMAND = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An HTTP field name. Lower-case, because `routingHeaders` uses it as written. */
const HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** What may precede a secret in a header value, with at most one trailing space. */
const HEADER_PREFIX = /^[A-Za-z0-9._~+/-]{0,32} ?$/;

/** Framing headers, refused although fetch drops most of them: the value is built from a pasted secret. */
const STRUCTURAL_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "keep-alive",
  "proxy-authorization",
  "cookie",
];

/** Refused on everything the install-approval card draws. Cc and Cf rather than C, so unassigned codepoints still pass. */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;

/** Variables that choose which code runs. A vendor's credential name cannot be refused this way. */
const RESERVED_ENV_LOADERS: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "RUBYOPT",
];

/** A plugin may not drive the operator's own signed-in CLI; script is what the login pty uses. */
const RESERVED_COMMANDS: readonly string[] = [...AGENT_IDS.map((id) => AGENT_LOGIN[id].command), "script"];

/** Derived from the built-in tables, so a new built-in can make a stored plugin unreadable; the plugin catalogue's hand-kept copy must follow. */
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
    if (RESERVED_ENV_LOADERS.includes(entry)) return `${what} may not name ${JSON.stringify(entry)}: that variable decides which code runs, not which service answers`;
    if (out.includes(entry)) return `${what} names ${JSON.stringify(entry)} twice`;
    out.push(entry);
  }
  return out;
}

function readHarnesses(raw: unknown, scopes: readonly PluginScope[], presenting: boolean): HarnessContribution[] | string {
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
    if (presenting && CONTROL_CHARS.test(name)) {
      return `harness ${JSON.stringify(id)} name may not carry control or formatting characters`;
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
    // Every argv word, not only the command: env or sh -c could otherwise invoke a reserved CLI.
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

    // Authoring hygiene only, so a stored row is not refused for it.
    const collision = presenting ? routedModelEnv.find((name) => envNames.includes(name)) : undefined;
    if (collision !== undefined) {
      return `harness ${JSON.stringify(id)} names ${JSON.stringify(collision)} as both a credential slot and a routed-model variable, and the model id would overwrite the key`;
    }

    const authHint = one["authHint"];
    if (
      authHint !== undefined &&
      authHint !== null &&
      (typeof authHint !== "string" || authHint.length > MAX_AUTH_HINT_CHARS)
    ) {
      return `harness ${JSON.stringify(id)} authHint must be a string of at most ${MAX_AUTH_HINT_CHARS} characters`;
    }
    if (presenting && typeof authHint === "string" && CONTROL_CHARS.test(authHint)) {
      return `harness ${JSON.stringify(id)} authHint may not carry control or formatting characters`;
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

/** Refused under https too: instance metadata is never an inference endpoint. */
function isMetadataHost(host: string): boolean {
  const four = ipv4(host);
  if (four !== null) {
    if (four[0] === 169 && four[1] === 254) return true;
    // Alibaba and Oracle serve metadata on routable addresses.
    if (four[0] === 100 && four[1] === 100 && four[2] === 100 && four[3] === 200) return true;
    if (four[0] === 192 && four[1] === 0 && four[2] === 0 && four[3] === 192) return true;
    return false;
  }
  // By name too: isPrivateHost accepts any .internal, GCP's metadata name included.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (METADATA_NAMES.has(bare) || bare.endsWith(".metadata.google.internal")) return true;
  // The IPv4-mapped IPv6 spelling, which ipv4 does not parse.
  return bare === "fd00:ec2::254" || bare.startsWith("::ffff:a9fe:") || bare.startsWith("::ffff:169.254.");
}

const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog"]);

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

/** Decides only whether http is allowed for a baseUrl, where a private model endpoint is legitimate. Not an SSRF defence. */
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
  // URL.hostname keeps the brackets on an IPv6 literal.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  return false;
}

/** https anywhere; http only to a host isPrivateHost recognises. */
function readBaseUrl(raw: unknown, what: string, presenting: boolean): string | null | string[] {
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
  // Strip the root label: URL keeps a trailing dot on a named host, which defeats the suffix tests.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  // Scheme first: file: and ws: parse to an empty authority.
  if (url.protocol !== "http:" && url.protocol !== "https:") return [`${what} baseUrl must be https`];
  if (isMetadataHost(host)) return [`${what} baseUrl names this host's own metadata service`];
  // A single label resolves through the search domain, so it is refused unless private.
  if (!host.includes(".") && !isPrivateHost(host)) {
    return [`${what} baseUrl must name a host with a dot in it, or this machine`];
  }
  if (url.protocol === "http:" && !isPrivateHost(host)) {
    return [`${what} baseUrl must be https, unless it names this machine or your own network`];
  }
  // Normalised once, so consentGap and storage compare the same string.
  const normalised = url.origin + url.pathname.replace(/\/+$/, "");
  // Bounded again, since percent-encoding lengthens it; a stored row past it is still loaded.
  if (presenting && normalised.length > MAX_BASE_URL_CHARS) {
    return [`${what} baseUrl is longer than ${MAX_BASE_URL_CHARS} characters once normalised`];
  }
  return normalised;
}

function readSystems(
  raw: unknown,
  scopes: readonly PluginScope[],
  harnesses: readonly HarnessContribution[],
  presenting: boolean,
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
    if (presenting && CONTROL_CHARS.test(name)) return `${what} name may not carry control or formatting characters`;

    // Only the closed pair this daemon knows how to configure, never ACP's open union.
    const apiType = one["apiType"];
    if (apiType !== "anthropic" && apiType !== "openai") {
      return `${what} apiType must be "anthropic" or "openai"`;
    }

    const baseUrlRead = readBaseUrl(one["baseUrl"], what, presenting);
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
      // Both halves go straight into a header, so they are allow-listed against CR/LF injection.
      if (typeof headerName !== "string" || !HEADER_NAME.test(headerName)) {
        return `${what} authHeader.name must be a lower-case header name, like authorization`;
      }
      if (STRUCTURAL_HEADERS.includes(headerName)) {
        return `${what} authHeader.name may not be ${JSON.stringify(headerName)}: that field frames the request rather than naming who is asking`;
      }
      const prefix = header["prefix"];
      if (prefix !== undefined && prefix !== null && (typeof prefix !== "string" || !HEADER_PREFIX.test(prefix))) {
        return `${what} authHeader.prefix must be a short word, like "Bearer "`;
      }
      authHeader = { name: headerName, prefix: typeof prefix === "string" ? prefix : "" };
    }

    const models = readSystemModels(one["models"], what, presenting);
    if (typeof models === "string") return models;

    const nativeModelPrefix = one["nativeModelPrefix"];
    if (
      nativeModelPrefix !== undefined &&
      nativeModelPrefix !== null &&
      (typeof nativeModelPrefix !== "string" || nativeModelPrefix.length === 0 || nativeModelPrefix.length > 32)
    ) {
      return `${what} nativeModelPrefix must be a short string, like "acme/"`;
    }
    if (presenting && typeof nativeModelPrefix === "string" && CONTROL_CHARS.test(nativeModelPrefix)) {
      return `${what} nativeModelPrefix may not carry control or formatting characters`;
    }

    const keyEnvRead = readEnvNames(one["keyEnv"] === undefined || one["keyEnv"] === null ? [] : [one["keyEnv"]], `${what} keyEnv`, 1);
    if (typeof keyEnvRead === "string") return keyEnvRead;
    const keyEnv = keyEnvRead[0] ?? null;

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
    // keyEnv must be a variable that harness declares, or systemSecretFor cannot borrow its key.
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

/** Only this plugin's own harnesses: naming a built-in would assert an equivalence Q3.488 refuses. */
function readOwnHarness(raw: unknown, own: readonly string[], what: string): string | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return { error: `${what} must be the id of a harness this plugin adds` };
  if (!own.includes(raw)) {
    return { error: `${what} names ${JSON.stringify(raw)}, which is not a harness this plugin adds` };
  }
  return raw;
}

function readSystemModels(raw: unknown, what: string, presenting: boolean): { id: string; name: string }[] | string {
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
    if (presenting && CONTROL_CHARS.test(id)) return `${what} has a model id carrying control or formatting characters`;
    const name = model["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_SYSTEM_MODEL_NAME_CHARS) {
      return `${what} model ${JSON.stringify(id)} needs a name of 1–${MAX_SYSTEM_MODEL_NAME_CHARS} characters`;
    }
    if (presenting && CONTROL_CHARS.test(name)) {
      return `${what} model ${JSON.stringify(id)} name may not carry control or formatting characters`;
    }
    if (out.some((seen) => seen.id === id)) return `${what} names model ${JSON.stringify(id)} twice`;
    out.push({ id, name: name.trim() });
  }
  return out;
}
