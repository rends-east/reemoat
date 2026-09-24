// Read by the browser so `src/` needs no proxy; the control plane's `connect-src` must name this origin.

import { CATALOGUE_TIMEOUT_MS } from "./catalogue";
import type { SystemInfo } from "./wire";

export const OPENROUTER_SYSTEM_ID = "openrouter";

/** Not derived from `SystemInfo.baseUrl`, which is the daemon's routing address and lacks `/v1`. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const OPENROUTER_TTL_MS = 10 * 60_000;

export const BATCH_VARIANT = ":batch";

export type OpenRouterRead =
  | {
      kind: "ok";
      models: SystemInfo["models"];
      /** Ids refused only for lacking tool support, so `allModels` drops them from published lists too (Q3.520). */
      toolless: readonly string[];
    }
  | { kind: "malformed"; reason: string }
  | { kind: "unreachable"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fails open: a bad row is skipped and unknown fields are ignored.
 * Drops models without tools and `:batch` rows (async Batch API, cannot finish a turn); names stay verbatim, never rebuilt from the id.
 */
export function readOpenRouterModels(raw: unknown): OpenRouterRead {
  if (!isObject(raw)) return { kind: "malformed", reason: "that is not a model list" };
  const data = raw["data"];
  if (!Array.isArray(data)) return { kind: "malformed", reason: "that answer has no list of models" };
  const models: SystemInfo["models"] = [];
  const toolless: string[] = [];
  const seen = new Set<string>();
  for (const one of data) {
    if (!isObject(one)) continue;
    const id = one["id"];
    const name = one["name"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || name.length === 0) continue;
    const params = one["supported_parameters"];
    if (!Array.isArray(params) || !params.includes("tools")) {
      // A missing `supported_parameters` counts as toolless: an agent is tools.
      toolless.push(id);
      continue;
    }
    if (id.endsWith(BATCH_VARIANT)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return { kind: "ok", models, toolless };
}

// Only an `ok` read is cached, so a failure stays retryable.
let cached: { at: number; read: OpenRouterRead } | null = null;
let inflight: Promise<OpenRouterRead> | null = null;

export async function fetchOpenRouterModels(now: number = Date.now()): Promise<OpenRouterRead> {
  if (cached !== null && now - cached.at < OPENROUTER_TTL_MS) return cached.read;
  if (inflight !== null) return inflight;
  inflight = (async (): Promise<OpenRouterRead> => {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
    } catch (error) {
      return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok) return { kind: "unreachable", reason: `the list answered ${response.status}` };
    try {
      return readOpenRouterModels(await response.json());
    } catch (error) {
      return { kind: "malformed", reason: error instanceof Error ? error.message : String(error) };
    }
  })()
    .then((read) => {
      if (read.kind === "ok") cached = { at: Date.now(), read };
      return read;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function forgetOpenRouterModels(): void {
  cached = null;
  inflight = null;
}

export function openRouterNotice(read: OpenRouterRead | null, displayName: string): string | null {
  if (read === null) return `Reading ${displayName}'s model list…`;
  if (read.kind === "ok") {
    return read.models.length === 0 ? `${displayName} lists no models that can use tools.` : null;
  }
  return `${displayName}'s model list could not be read on this device.`;
}
