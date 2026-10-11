import { mkdirSync, writeFileSync } from "node:fs";
import { HARNESS_DOORS } from "../src/acp/doors.js";
import { join } from "node:path";
import type { DoorRecipe, ProbeRoute } from "./doorprobe.drive.js";

type Backend = "chat_completions" | "responses" | "messages";
type TomlValue = string | number | string[] | Record<string, string>;

interface GrokConfig {
  models: Record<string, TomlValue>;
  model: Record<string, Record<string, TomlValue>>;
}

interface Shape {
  backend: Backend;
  credential: "env_key" | "api_key" | "none";
  /** extra_headers beside the credential: another authorization, the route's key as x-api-key, and a header no SDK sets. */
  headers: boolean;
  select: "default" | "pin";
  /** "bare" leaves one inference request per turn on the recorder, so a script's steps are spent on turns alone. */
  aux: "routed" | "bare";
}

/** grok publishes the catalogue key on its model control and sends the block's `model` on the wire. */
const KEY = "doorprobe";
const TITLE_KEY = "doorprobe-title";
const TOKEN_ENV = "DOORPROBE_GROK_TOKEN";
/** TCP discard: nothing listens, so a request aimed here fails at once and reaches nobody. */
const NOWHERE = "http://127.0.0.1:9/v1";

const RECOMMENDED: Omit<Shape, "backend"> = { credential: "env_key", headers: false, select: "default", aux: "routed" };

function grokConfig(route: ProbeRoute, shape: Shape): GrokConfig {
  const bare = shape.aux === "bare";
  const models: Record<string, TomlValue> = { session_summary: bare ? TITLE_KEY : KEY };
  if (shape.select === "default") {
    models["default"] = KEY;
    models["allowed_models"] = [KEY];
  }
  const block: Record<string, TomlValue> = {
    model: route.model,
    base_url: `${route.baseUrl}/v1`,
    name: "Door probe",
    api_backend: shape.backend,
    context_window: 200_000,
  };
  if (shape.credential === "env_key") block["env_key"] = TOKEN_ENV;
  if (shape.credential === "api_key") block["api_key"] = route.bearer;
  if (shape.headers) {
    block["extra_headers"] = {
      authorization: "Bearer doorprobe-header-value",
      "x-api-key": route.bearer,
      "x-doorprobe-grant": "passes",
    };
  }
  const model: GrokConfig["model"] = { [KEY]: block };
  if (bare) model[TITLE_KEY] = { model: "title-nowhere", base_url: NOWHERE, api_key: "unused", max_retries: 0 };
  return { models, model };
}

function tomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  const pairs = Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)} = ${JSON.stringify(inner)}`);
  return `{ ${pairs.join(", ")} }`;
}

function toToml(config: GrokConfig): string {
  const pairs = (table: Record<string, TomlValue>): string[] =>
    Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  const lines = ["[models]", ...pairs(config.models)];
  for (const [key, block] of Object.entries(config.model)) lines.push("", `[model.${key}]`, ...pairs(block));
  return `${lines.join("\n")}\n`;
}

/** Relocated so the person's ~/.grok is neither read for a login nor written; the conversation lives here, so a resume needs the same directory. */
function relocatedHome(route: ProbeRoute): string {
  const home = join(route.scratch, "grok-home");
  mkdirSync(home, { recursive: true });
  return home;
}

function tokenEnv(route: ProbeRoute, shape: Shape): NodeJS.ProcessEnv {
  return {
    ...(shape.credential === "env_key" ? { [TOKEN_ENV]: route.bearer } : {}),
    ...(shape.aux === "bare" ? { GROK_TURN_SUMMARY: "0", GROK_TITLE_REFRESH: "0" } : {}),
  };
}

function homeDoor(name: string, about: string, shape: Shape): DoorRecipe {
  return {
    agent: "grok",
    name,
    about,
    routed: true,
    spawnEnv: (route) => {
      const home = relocatedHome(route);
      // Rewritten before every spawn: grok appends its own [marketplace] table to this file on launch.
      writeFileSync(join(home, "config.toml"), toToml(grokConfig(route, shape)), { mode: 0o600 });
      return { GROK_HOME: home, ...tokenEnv(route, shape) };
    },
    pin: () => (shape.select === "pin" ? KEY : null),
  };
}

function overlayDoor(name: string, about: string, carrier: "inline" | "path"): DoorRecipe {
  const shape: Shape = { ...RECOMMENDED, backend: "chat_completions" };
  return {
    agent: "grok",
    name,
    about,
    routed: true,
    spawnEnv: (route) => {
      const env: NodeJS.ProcessEnv = { GROK_HOME: relocatedHome(route), ...tokenEnv(route, shape) };
      const config = grokConfig(route, shape);
      if (carrier === "inline") {
        env["GROK_CONFIG"] = JSON.stringify(config);
      } else {
        const file = join(route.scratch, "grok-overlay.toml");
        writeFileSync(file, toToml(config), { mode: 0o600 });
        env["GROK_CONFIG_PATH"] = file;
      }
      return env;
    },
  };
}

const BACKENDS: readonly (readonly [string, Backend])[] = [
  ["chat", "chat_completions"],
  ["responses", "responses"],
  ["messages", "messages"],
];

function productionDoor(route: ProbeRoute): NodeJS.ProcessEnv {
  const door = HARNESS_DOORS.grok;
  if (door?.via !== "spawn") throw new Error("grok has no door set at the spawn");
  return door.prepare({
    origin: route.baseUrl,
    bearer: route.bearer,
    model: route.model,
    protocol: route.protocol ?? "anthropic-messages",
    home: join(route.scratch, "door-home"),
  });
}

function heldByDoor(model: string): string | null {
  const door = HARNESS_DOORS.grok;
  return door?.via === "spawn" ? door.held(model) : null;
}

export const GROK_DOORS: readonly DoorRecipe[] = [
  {
    agent: "grok",
    name: "door",
    about: "The door in production: HARNESS_DOORS.grok, meant for --gateway, where the address it is handed is this daemon's own.",
    routed: true,
    spawnEnv: (route) => productionDoor(route),
    pin: (route) => heldByDoor(route.model),
  },
  ...BACKENDS.map(([short, backend]) =>
    homeDoor(
      `home-${short}`,
      `The door: a GROK_HOME under scratch whose config.toml defines [model.${KEY}] on ${backend}, the token in the environment through env_key, named by [models] default, session_summary and allowed_models.`,
      { ...RECOMMENDED, backend },
    ),
  ),
  ...BACKENDS.map(([short, backend]) =>
    homeDoor(
      `home-${short}-bare`,
      `The same door on ${backend} with the title sent to a closed port and the turn summary and title refresh off, for error and reasoning scripts.`,
      { ...RECOMMENDED, backend, aux: "bare" },
    ),
  ),
  homeDoor("home-file-key", "The same door with the token inline as api_key in config.toml, mode 0600, and nothing in the environment.", {
    ...RECOMMENDED,
    backend: "chat_completions",
    credential: "api_key",
  }),
  homeDoor(
    "home-pin",
    "No [models] default: the session is born on grok's own model, prewarms xAI's origin, and is moved by session/set_config_option.",
    { ...RECOMMENDED, backend: "chat_completions", select: "pin" },
  ),
  homeDoor(
    "home-headers",
    "api_key beside extra_headers: which authorization reaches the wire, and whether x-api-key and an unknown header pass.",
    { ...RECOMMENDED, backend: "chat_completions", credential: "api_key", headers: true },
  ),
  homeDoor("home-headers-only", "extra_headers as the only credential: grok counts no key and refuses session/new.", {
    ...RECOMMENDED,
    backend: "chat_completions",
    credential: "none",
    headers: true,
  }),
  homeDoor("home-keyless", "A model block with no credential at all in a home with no login: session/new is refused.", {
    ...RECOMMENDED,
    backend: "chat_completions",
    credential: "none",
  }),
  {
    agent: "grok",
    name: "env",
    about:
      "Environment only, in an empty GROK_HOME: GROK_MODELS_BASE_URL replaces the catalogue with the endpoint's /models, XAI_API_KEY is the token, and GROK_XAI_API_BASE_URL keeps grok's key check off api.x.ai.",
    routed: true,
    spawnEnv: (route) => ({
      GROK_HOME: relocatedHome(route),
      GROK_MODELS_BASE_URL: `${route.baseUrl}/v1`,
      GROK_XAI_API_BASE_URL: `${route.baseUrl}/v1`,
      XAI_API_KEY: route.bearer,
      GROK_DEFAULT_MODEL: route.model,
      GROK_SESSION_SUMMARY_MODEL: route.model,
    }),
  },
  overlayDoor("overlay-inline", "The door's config as inline JSON in GROK_CONFIG: the overlay allowlist drops [model.*], so nothing is routed.", "inline"),
  overlayDoor("overlay-path", "The door's config as a TOML file named by GROK_CONFIG_PATH: dropped by the same allowlist.", "path"),
];
