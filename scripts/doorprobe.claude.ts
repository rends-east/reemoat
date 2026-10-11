import type * as acp from "@agentclientprotocol/sdk";
import { ROUTED_MODEL_ENV, type AgentRouting } from "../src/acp/systems.js";
import type { DoorRecipe, ProbeRoute } from "./doorprobe.drive.js";

function providersSet(name: string, about: string, header: (bearer: string) => Record<string, string>): DoorRecipe {
  return {
    agent: "claude",
    name,
    about,
    routed: true,
    spawnEnv: (route) => ROUTED_MODEL_ENV.claude?.(route.model) ?? {},
    provider: (route: ProbeRoute, routing: AgentRouting): acp.SetProviderRequest => ({
      providerId: routing.providerId,
      apiType: "anthropic",
      baseUrl: route.baseUrl,
      headers: header(route.bearer),
    }),
  };
}

export const CLAUDE_DOORS: readonly DoorRecipe[] = [
  providersSet(
    "providers-set",
    "The door in production: providers/set for the endpoint, ROUTED_MODEL_ENV for the model, the key as authorization: Bearer.",
    (bearer) => ({ authorization: `Bearer ${bearer}` }),
  ),
  providersSet("providers-set-x-api-key", "The same door with the key as x-api-key.", (bearer) => ({
    "x-api-key": bearer,
  })),
  providersSet("providers-set-own-header", "The same door with the key in a header no SDK sets.", (bearer) => ({
    "x-doorprobe-grant": bearer,
  })),
];
