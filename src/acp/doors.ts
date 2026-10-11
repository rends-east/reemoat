import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBuiltinAgentId, type AgentId, type BuiltinAgentId } from "./agents.js";
import type { WireProtocol } from "./systems.js";

/** What a door is given to point one agent process at the gateway. */
export interface DoorLaunch {
  /** The gateway's address: loopback, no path. */
  origin: string;
  bearer: string;
  model: string;
  protocol: WireProtocol;
  /** A directory of this daemon's, the same at every launch of this session: the door may fill it, and the harness keeps the conversation there. */
  home: string;
}

/**
 * How a harness this repository ships is handed the daemon's gateway in place of a vendor. A row exists once the door has
 * been measured closed: that nothing of a conversation leaves by another way (Q7.155).
 */
export type HarnessDoor =
  | {
      via: "providers-set";
      /** The protocols this door carries, most preferred first. */
      speaks: readonly WireProtocol[];
      /** What providers/set is given to carry the one-launch credential. */
      grantHeaders(bearer: string): Record<string, string>;
    }
  | {
      via: "spawn";
      speaks: readonly WireProtocol[];
      /** Whether the home is one per session or one for every session of this harness. */
      home: "session" | "harness";
      /** The environment the process starts with. May write under launch.home and nowhere else. */
      prepare(launch: DoorLaunch): NodeJS.ProcessEnv;
      /** What the harness's own model control must read once the session is open; anything else is another model. */
      held(model: string): string;
    };

/** The provider every routed opencode session names. Constant: a session reopened under another id falls back to opencode's own models (Q6.126). */
const OPENCODE_PROVIDER = "reemoat";
const OPENCODE_PACKAGE: Record<WireProtocol, string> = {
  "anthropic-messages": "@ai-sdk/anthropic",
  "openai-responses": "@ai-sdk/openai",
  "openai-chat": "@ai-sdk/openai-compatible",
};

/** The variable grok reads its credential from, named in the config this daemon writes it. */
const GROK_BEARER_ENV = "REEMOAT_MODEL_BEARER";
const GROK_BACKEND: Record<WireProtocol, string> = {
  "anthropic-messages": "messages",
  "openai-responses": "responses",
  "openai-chat": "chat_completions",
};

/** grok lists a block's key on its model control and sends the block's `model` on the wire; the key is what a person reads. */
function grokKey(model: string): string {
  const key = model.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key.length > 0 ? key.slice(0, 64) : "model";
}

export const HARNESS_DOORS: Partial<Record<BuiltinAgentId, HarnessDoor>> = {
  // x-api-key: claude replaces a header named authorization with a constant of its own (Q6.123).
  claude: { via: "providers-set", speaks: ["anthropic-messages"], grantHeaders: (bearer) => ({ "x-api-key": bearer }) },

  // Every key that names a model, or the title and a compaction follow the person's own config to another vendor (Q6.126).
  opencode: {
    via: "spawn",
    speaks: ["anthropic-messages", "openai-responses", "openai-chat"],
    home: "harness",
    held: (model) => `${OPENCODE_PROVIDER}/${model}`,
    prepare: ({ origin, bearer, model, protocol, home }) => {
      const named = `${OPENCODE_PROVIDER}/${model}`;
      return {
        // Its own home: no config of the person's to merge under, no sign-in of theirs to spend, and their sessions left alone.
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: named,
          small_model: named,
          enabled_providers: [OPENCODE_PROVIDER],
          disabled_providers: [],
          share: "disabled",
          agent: { title: { model: named }, summary: { model: named }, compaction: { model: named } },
          provider: {
            [OPENCODE_PROVIDER]: {
              npm: OPENCODE_PACKAGE[protocol],
              name: "Reemoat",
              options: { baseURL: `${origin}/v1`, apiKey: bearer },
              models: { [model]: { name: model } },
            },
          },
        }),
      };
    },
  },

  // A file, in a home of this daemon's: grok's overlay variables drop a model block, and one beside a person's login would mean writing their config (Q6.127).
  grok: {
    via: "spawn",
    speaks: ["anthropic-messages", "openai-responses", "openai-chat"],
    home: "session",
    held: grokKey,
    prepare: ({ origin, model, bearer, protocol, home }) => {
      const key = grokKey(model);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Rewritten at every launch: grok appends a section of its own. default and session_summary both, or the title names an xAI model.
      writeFileSync(
        join(home, "config.toml"),
        [
          "[models]",
          `default = ${JSON.stringify(key)}`,
          `session_summary = ${JSON.stringify(key)}`,
          `allowed_models = [${JSON.stringify(key)}]`,
          "",
          `[model.${key}]`,
          `model = ${JSON.stringify(model)}`,
          `base_url = ${JSON.stringify(`${origin}/v1`)}`,
          `api_backend = ${JSON.stringify(GROK_BACKEND[protocol])}`,
          `env_key = ${JSON.stringify(GROK_BEARER_ENV)}`,
          // A 5xx is otherwise retried 45 times over seventeen minutes with nothing said.
          "max_retries = 2",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      // An xAI key in the daemon's own environment would be checked against xAI at initialize and spent by any block without one.
      return { GROK_HOME: home, [GROK_BEARER_ENV]: bearer, XAI_API_KEY: undefined };
    },
  },
};

/** null for a harness a plugin added: nothing is known about what its adapter does with a header, so it is routed at the vendor itself. */
export function doorOf(harness: AgentId): HarnessDoor | null {
  return isBuiltinAgentId(harness) ? (HARNESS_DOORS[harness] ?? null) : null;
}
