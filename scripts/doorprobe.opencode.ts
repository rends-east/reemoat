import { join } from "node:path";
import { HARNESS_DOORS } from "../src/acp/doors.js";
import type { DoorRecipe, ProbeRoute } from "./doorprobe.drive.js";

// Kept across launches: opencode stores this id with the session and reopens on its default model when it is gone.
const PROVIDER = "doorprobe";
const KEY_ENV = "DOORPROBE_OPENCODE_KEY";
const CONTEXT = 123_456;
const OUTPUT = 4_321;

const PACKAGES = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  messages: "@ai-sdk/anthropic",
} as const;

type Protocol = keyof typeof PACKAGES;

interface Shape {
  protocol: Protocol;
  /** Everything beside the provider: the default model, the title and compaction models, and the closed provider list. */
  closed: boolean;
  key: "inline" | "env";
  /** Own is the person's real opencode config and data, which a run adds a session row to. */
  home: "isolated" | "own";
  /** Declares the model as a reasoning one, which publishes an effort control whose first value is sent by default. */
  reasoning: boolean;
}

function inlineConfig(route: ProbeRoute, shape: Shape): string {
  const named = `${PROVIDER}/${route.model}`;
  const closed = {
    model: named,
    small_model: named,
    enabled_providers: [PROVIDER],
    disabled_providers: [],
    share: "disabled",
    // A person's agent.<name>.model outranks small_model, so each hidden agent is named.
    agent: { title: { model: named }, summary: { model: named }, compaction: { model: named } },
  };
  return JSON.stringify({
    ...(shape.closed ? closed : {}),
    provider: {
      [PROVIDER]: {
        npm: PACKAGES[shape.protocol],
        name: "Doorprobe",
        // Never without apiKey: two of the three packages then send the vendor key found in the environment.
        options: { baseURL: `${route.baseUrl}/v1`, apiKey: shape.key === "inline" ? route.bearer : `{env:${KEY_ENV}}` },
        models: {
          [route.model]: {
            name: "Probe model",
            limit: { context: CONTEXT, output: OUTPUT },
            ...(shape.reasoning ? { reasoning: true } : {}),
          },
        },
      },
    },
  });
}

function isolatedHome(route: ProbeRoute): NodeJS.ProcessEnv {
  const home = join(route.scratch, "home");
  return {
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_TEST_HOME: home,
  };
}

function door(name: string, about: string, change: Partial<Shape>): DoorRecipe {
  const shape: Shape = { protocol: "chat", closed: true, key: "inline", home: "isolated", reasoning: true, ...change };
  return {
    agent: "opencode",
    name,
    about,
    routed: true,
    spawnEnv: (route) => ({
      OPENCODE_CONFIG_CONTENT: inlineConfig(route, shape),
      ...(shape.key === "env" ? { [KEY_ENV]: route.bearer } : {}),
      ...(shape.home === "isolated" ? isolatedHome(route) : {}),
    }),
    // Always pinned: an unpinned session on a provider-only config opens on opencode/big-pickle and prompts OpenCode Zen.
    pin: (route) => `${PROVIDER}/${route.model}`,
  };
}

const SPEAKS: Record<Protocol, string> = { chat: "Chat Completions", responses: "Responses", messages: "Messages" };

function productionDoor(route: ProbeRoute): NodeJS.ProcessEnv {
  const door = HARNESS_DOORS.opencode;
  if (door?.via !== "spawn") throw new Error("opencode has no door set at the spawn");
  return door.prepare({
    origin: route.baseUrl,
    bearer: route.bearer,
    model: route.model,
    protocol: route.protocol ?? "anthropic-messages",
    home: join(route.scratch, "door-home"),
  });
}

function heldByDoor(model: string): string | null {
  const door = HARNESS_DOORS.opencode;
  return door?.via === "spawn" ? door.held(model) : null;
}

export const OPENCODE_DOORS: readonly DoorRecipe[] = [
  {
    agent: "opencode",
    name: "door",
    about: "The door in production: HARNESS_DOORS.opencode, meant for --gateway, where the address it is handed is this daemon's own.",
    routed: true,
    spawnEnv: (route) => productionDoor(route),
    pin: (route) => heldByDoor(route.model),
  },
  ...(Object.keys(PACKAGES) as Protocol[]).flatMap((protocol) => [
    door(
      `config-${protocol}`,
      `The door: OPENCODE_CONFIG_CONTENT naming one ${SPEAKS[protocol]} provider (${PACKAGES[protocol]}), the only one enabled, with every auxiliary model on it; pinned.`,
      { protocol },
    ),
    door(
      `config-${protocol}-provider-only`,
      `${SPEAKS[protocol]} with the provider alone inline: the session opens on Zen until the pin, and a person's small_model would take the title call.`,
      { protocol, closed: false },
    ),
  ]),
  door("config-chat-plain", "The door without reasoning declared on the model: no effort control and no reasoning fields on the wire.", { reasoning: false }),
  door("config-chat-env-key", "The door with the key as {env:…} rather than inline.", { key: "env" }),
  door("config-chat-own-home", "The door over the person's own opencode config and data, for the merge. Adds a session row to their opencode.db.", { home: "own" }),
];
