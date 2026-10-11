import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoorRecipe, ProbeRoute } from "./doorprobe.drive.js";

// The control publishes the door's model under this value, with the model's id as the choice's name.
const ENV_MODEL_ALIAS = "__kimi_env_model__";

type EnvProviderType = "anthropic" | "openai" | "kimi" | "openai_responses";

// The anthropic client appends /v1/messages itself; the chat clients append only /chat/completions.
function baseUrlFor(type: EnvProviderType | null, route: ProbeRoute): string {
  return type === "anthropic" ? route.baseUrl : `${route.baseUrl}/v1`;
}

function envDoor(name: string, about: string, type: EnvProviderType | null, ownHome: boolean): DoorRecipe {
  return {
    agent: "kimi",
    name,
    about,
    routed: true,
    spawnEnv: (route: ProbeRoute) => ({
      ...(type === null ? {} : { KIMI_MODEL_PROVIDER_TYPE: type }),
      KIMI_MODEL_BASE_URL: baseUrlFor(type, route),
      KIMI_MODEL_API_KEY: route.bearer,
      KIMI_MODEL_NAME: route.model,
      // An inherited value replaces the bearer on the chat types; empty reads as unset.
      KIMI_CODE_CUSTOM_HEADERS: "",
      ...(ownHome
        ? {
            // With no key beside them these cut both tools off from the services the person's config names.
            KIMI_WEB_SEARCH_BASE_URL: `${route.baseUrl}/kimi-search`,
            KIMI_WEB_FETCH_BASE_URL: `${route.baseUrl}/kimi-fetch`,
          }
        : { KIMI_CODE_HOME: join(route.scratch, "home") }),
    }),
    pin: () => ENV_MODEL_ALIAS,
  };
}

const tomlString = (value: string): string => JSON.stringify(value);

// kimi acp takes no config path, so a provider type the env door rejects can only come from a home's config.toml.
const homeResponses: DoorRecipe = {
  agent: "kimi",
  name: "home-openai-responses",
  about: "No env door reaches Responses: a provider written into a relocated home's config.toml, the key as authorization: Bearer.",
  routed: true,
  spawnEnv: (route: ProbeRoute) => {
    const home = join(route.scratch, "home");
    const alias = `door/${route.model}`;
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.toml"),
      [
        `default_model = ${tomlString(alias)}`,
        ``,
        `[providers.door]`,
        `type = "openai_responses"`,
        `api_key = ${tomlString(route.bearer)}`,
        `base_url = ${tomlString(`${route.baseUrl}/v1`)}`,
        ``,
        `[models.${tomlString(alias)}]`,
        `provider = "door"`,
        `model = ${tomlString(route.model)}`,
        `max_context_size = 262144`,
        `capabilities = [ "thinking", "tool_use" ]`,
        ``,
      ].join("\n"),
    );
    return { KIMI_CODE_HOME: home };
  },
  pin: (route: ProbeRoute) => `door/${route.model}`,
};

export const KIMI_DOORS: readonly DoorRecipe[] = [
  envDoor(
    "env-anthropic",
    "KIMI_MODEL_* naming an anthropic provider on an empty relocated home: Messages, the key as x-api-key.",
    "anthropic",
    false,
  ),
  envDoor(
    "env-openai",
    "KIMI_MODEL_* naming an openai provider on an empty relocated home: Chat Completions, the key as authorization: Bearer.",
    "openai",
    false,
  ),
  envDoor(
    "env-kimi",
    "KIMI_MODEL_* naming a kimi provider on an empty relocated home: Chat Completions in Moonshot's dialect, with x-msh-* device headers.",
    "kimi",
    false,
  ),
  envDoor("env-untyped", "KIMI_MODEL_* with no provider type, which is the kimi type.", null, false),
  envDoor(
    "env-openai-responses",
    "A type the env door rejects: the whole door is ignored with a log line, and the session falls back to the home's own config.",
    "openai_responses",
    false,
  ),
  envDoor(
    "env-anthropic-own-home",
    "The anthropic door over the person's own ~/.kimi-code, which kimi then writes a session into; search and fetch cut off from their Kimi services.",
    "anthropic",
    true,
  ),
  homeResponses,
];
