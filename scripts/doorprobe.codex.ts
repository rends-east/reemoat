import type * as acp from "@agentclientprotocol/sdk";
import { codexConfigEnv } from "../src/acp/agents.js";
import type { AgentRouting } from "../src/acp/systems.js";
import type { DoorRecipe, ProbeRoute } from "./doorprobe.drive.js";

type Config = Record<string, unknown>;

function configEnv(config: Config): NodeJS.ProcessEnv {
  const value = codexConfigEnv(JSON.stringify(config));
  return value === undefined ? {} : { CODEX_CONFIG: value };
}

const bearerHeader = (route: ProbeRoute): Record<string, string> => ({ authorization: `Bearer ${route.bearer}` });

interface ProvidersSetShape {
  name: string;
  about: string;
  /** codex appends /responses to whatever it is given. */
  base?: (route: ProbeRoute) => string;
  headers?: (route: ProbeRoute) => Record<string, string>;
  config?: (route: ProbeRoute) => Config;
  pin?: (route: ProbeRoute) => string | null;
}

function providersSet(shape: ProvidersSetShape): DoorRecipe {
  const recipe: DoorRecipe = {
    agent: "codex",
    name: shape.name,
    about: shape.about,
    routed: true,
    spawnEnv: (route) => configEnv(shape.config === undefined ? { model: route.model } : shape.config(route)),
    provider: (route: ProbeRoute, routing: AgentRouting): acp.SetProviderRequest => ({
      providerId: routing.providerId,
      apiType: "openai",
      baseUrl: shape.base === undefined ? `${route.baseUrl}/v1` : shape.base(route),
      headers: (shape.headers ?? bearerHeader)(route),
    }),
  };
  if (shape.pin !== undefined) recipe.pin = shape.pin;
  return recipe;
}

export const CODEX_DOORS: readonly DoorRecipe[] = [
  providersSet({
    name: "routed",
    about:
      "The door to take: providers/set with <address>/v1 and authorization: Bearer; CODEX_CONFIG {model} with the ChatGPT connector tools and the web_search server tool switched off.",
    config: (route) => ({ model: route.model, features: { apps: false }, web_search: "disabled" }),
  }),
  providersSet({
    name: "providers-set",
    about: "providers/set with <address>/v1, the key as authorization: Bearer, CODEX_CONFIG {model} and nothing else.",
  }),
  providersSet({
    name: "providers-set-bare",
    about: "The same door with the address as given, no /v1.",
    base: (route) => route.baseUrl,
  }),
  providersSet({
    name: "providers-set-x-api-key",
    about: "The same door with the key as x-api-key.",
    headers: (route) => ({ "x-api-key": route.bearer }),
  }),
  providersSet({
    name: "providers-set-own-header",
    about: "The same door with the key in a header no SDK sets, so nothing of ours is in authorization.",
    headers: (route) => ({ "x-doorprobe-grant": route.bearer }),
  }),
  providersSet({
    name: "providers-set-no-model",
    about: "providers/set alone: CODEX_CONFIG names no model, so the request shows what codex names by itself.",
    config: () => ({}),
  }),
  providersSet({
    name: "providers-set-pin",
    about: "providers/set, no model in CODEX_CONFIG, the model put on the control through session/set_config_option.",
    config: () => ({}),
    pin: (route) => route.model,
  }),
  {
    agent: "codex",
    name: "config-only",
    about: "No providers/set: CODEX_CONFIG carries model, model_provider and the provider's own table.",
    routed: true,
    spawnEnv: (route) =>
      configEnv({
        model: route.model,
        model_provider: "doorprobe",
        model_providers: {
          doorprobe: {
            name: "doorprobe",
            base_url: `${route.baseUrl}/v1`,
            wire_api: "responses",
            http_headers: bearerHeader(route),
          },
        },
      }),
  },
];
