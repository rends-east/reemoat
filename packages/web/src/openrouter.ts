/*
 * OpenRouter's model list, read by the browser.
 *
 * ⚠ **The second catalogue in this app that a daemon does not serve, and the
 * reason is the same one the plugin market's is.** `catalogue.ts` is the
 * precedent and this is deliberately its shape: a pure reader, a transport around
 * it, and a sentence per failure. What it is *not* is that file's posture — see
 * {@link readOpenRouterModels} on why this one fails open where that one fails
 * closed.
 *
 * ⚠ **This request exists so that `src/` does not grow one.** Nothing in the
 * daemon proxies it: `compatibility.md` states the count of `fetch` calls in that
 * package as the property, and a proxy route would also make the daemon's own
 * reachability the gate on a list that has nothing to do with it.
 *
 * ⚠ **It reaches a third origin, so the document's `connect-src` has to name it**
 * — `packages/control-plane/src/app.ts`, unconditionally, because every instance
 * compiles in the same `SYSTEMS`. Without that the browser refuses its own
 * request before a byte leaves, as a bare `TypeError` with no status, and the
 * only symptom is a provider whose section never fills.
 *
 * No credential, ever. This endpoint answers with no auth and this app has none
 * to offer a third party — `cp.ts`'s standing "only ever to this origin" rule.
 *
 * DOM-free on purpose, so `webcheck` drives it.
 */

import { CATALOGUE_TIMEOUT_MS } from "./catalogue";
import type { SystemInfo } from "./wire";

/**
 * The id the daemon's table uses for this system, in one place.
 *
 * ⚠ **Compared against `SystemInfo.id`, which is `string` on purpose.** A daemon
 * too old to know this system simply never matches, and the client draws five
 * providers and asks nobody anything — which is what that field was widened for.
 */
export const OPENROUTER_SYSTEM_ID = "openrouter";

/**
 * Where the list is.
 *
 * Not derived from `SystemInfo.baseUrl`: that one is the *daemon's* — where a
 * routed session's traffic goes — and it is deliberately spelled without the
 * `/v1` the SDK appends. Two different addresses that happen to share a host.
 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * How long a read is reused within one tab.
 *
 * `MODELS_TTL_MS` in `src/agentask.ts` is the same ten minutes for the *other*
 * model list this screen draws, and the two ageing alike is the point: a picker
 * whose halves go stale on different clocks answers "why is this one here and
 * that one not" with nothing.
 */
export const OPENROUTER_TTL_MS = 10 * 60_000;

/**
 * OpenRouter's suffix for the Batch API's pricing row. Exported so `webcheck`
 * drives the real string rather than a second copy of it.
 */
export const BATCH_VARIANT = ":batch";

export type OpenRouterRead =
  | {
      kind: "ok";
      models: SystemInfo["models"];
      /**
       * The ids this read saw and **refused for having no tool support**.
       *
       * ⚠ **Not "everything left out".** A malformed row is not in it, and neither
       * is a `:batch` id — those are refused for reasons that say nothing about
       * whether the model can call a tool. This list is one statement and one
       * only: *OpenRouter says this model does not support tools.*
       *
       * It exists because the filter above was only ever applied to the list this
       * browser fetches, and that is not the only list. opencode publishes its own
       * 362 — unfiltered, image models and all — and `allModels` merged them in as
       * `published` rows, so a model the catalogue had already refused came back
       * through the other door and was offered. Assembling one produced a session
       * that failed on its first turn with OpenRouter's own accurate sentence:
       * *"No endpoints found that support tool use."* Q3.520.
       */
      toolless: readonly string[];
    }
  | { kind: "malformed"; reason: string }
  | { kind: "unreachable"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The list, as the two fields this app has anywhere to put.
 *
 * ⚠ **Fails *open*, which is the opposite of `catalogue.ts`, and the difference
 * is what is being read.** A half-read catalogue entry there is a half-read
 * **permission** list — somebody granting a plugin access to their sessions — and
 * that one may not guess. This is a list of names. A malformed entry here costs
 * one row nobody can see is missing, and refusing all 356 over one of them is the
 * failure this app avoids everywhere else.
 *
 * ⚠ **Unknown fields are ignored and always will be.** The live object carries
 * eighteen keys — `pricing`, `architecture`, `top_provider`, `knowledge_cutoff`
 * and more — none of which this app has a screen for, and a reader that refused a
 * key it had not heard of would go dark on the next thing OpenRouter adds.
 *
 * ⚠ **Two filters, and they are one rule stated twice.** Both drop a row whose
 * only possible outcome is a confusing failure at somebody else's endpoint, which
 * is why they sit on adjacent lines rather than in two places.
 *
 * - **`"tools"` in `supported_parameters`.** A model that cannot call tools fails
 *   on the first turn of any coding session.
 * - **An id ending `:batch`.** Not a routing variant: OpenRouter documents seven
 *   of those (`:free`, `:extended`, `:exacto`, `:thinking`, `:online`, `:nitro`,
 *   `:floor`) and there is no page for this one, because it is not one. It is the
 *   catalogue row for the **Batch API**'s pricing tier — `POST /api/beta/batches`,
 *   whose *only* supported completion window is 24 hours, whose submission answers
 *   `202 Accepted` with `status: "validating"`, and which takes a bare slug rather
 *   than this suffix. Both doors this app has are synchronous — `/v1/messages` for
 *   a routed pairing, `/v1/chat/completions` for opencode's — so nothing here can
 *   submit one, nothing here can poll one, and a turn ending in 24 hours has no
 *   representation in the event union at all. The row is priced at half, which
 *   makes `anthropic/claude-opus-5:batch` the most attractive-looking line in the
 *   picker and the one that cannot complete a turn.
 *
 * ⚠ **`endsWith` rather than a variant allow-list, and the limitation is the
 * point.** Measured over the whole live list: an id carries **at most one** colon
 * and never one before the `/`, and the only two suffixes in existence are
 * `batch` and `free` — so `deepseek/batch` would survive, having no colon at all.
 * An allow-list of understood variants would drop `:free` (18 usable rows) unless
 * enumerated and would go dark on the next *synchronous* variant OpenRouter adds;
 * a deny-list goes dark only on the next *asynchronous* one, which is the rarer
 * event. It will not catch a future `:async` or `:flex`, and that is accepted.
 *
 * Measured 2026-08-27, and the catalogue moves — it grew by one model between two
 * reads an hour apart, so no count here is a constant: 417 models, 348 with tools,
 * 59 of those `:batch`, **289 kept**. 58 of the 59 duplicate a base already in the
 * list; the one that does not, `openai/gpt-5-codex:batch`, is the batch tier of a
 * model whose synchronous tier has **no serving endpoint at all** — `GET
 * /models/openai/gpt-5-codex/endpoints` answers an empty array — so nothing
 * reachable is lost. Nothing downstream re-filters: `AgentBuilder` substitutes
 * this list into `SystemInfo.models` before `allModels` runs, so filtering
 * anywhere later would mean filtering in four functions instead of one.
 *
 * ⚠ **The daemon is *not* taught either filter.** `MAX_MODEL_CHARS` stays its only
 * model validation, so a `:batch` id already stored in an assembled agent goes on
 * being sent rather than being retroactively broken — the same tolerance the tools
 * filter has always granted.
 *
 * ⚠ **The `name` is carried verbatim and is never rebuilt from the id.**
 * Stripping a `"<Vendor>: "` prefix looks tidy and is a rule with a hole:
 * measured, 19 of the 348 carry no prefix at all (`Claude Opus 5`,
 * `Ling-3.0-flash`, `Auto Router (Beta)`), and four vendors disagree with
 * themselves — `anthropic/claude-opus-5` is `Claude Opus 5` while
 * `anthropic/claude-sonnet-5` is `Anthropic: Claude Sonnet 5`. Stripping would
 * draw those two as products of two different companies under one heading.
 *
 * The one name this app *does* cut is the other list's, and it is a different act:
 * `withoutProviderLabel` removes the system's own `displayName` from a **published**
 * name, matching one known constant rather than inferring a pattern out of somebody
 * else's prose. Nothing here may do the same, because here there is no constant to
 * match — the vendor half is exactly the unknown this paragraph is about.
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
      // Recorded rather than merely skipped — see `toolless`. A row whose
      // `supported_parameters` is missing or malformed counts: the catalogue not
      // saying a model supports tools is the whole of what can be known here, and
      // an agent is tools.
      toolless.push(id);
      continue;
    }
    if (id.endsWith(BATCH_VARIANT)) continue;
    // Deduplicated on the id, which is what `allModels` compares and what is
    // stored — the same rule that function already applies to its two sources.
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return { kind: "ok", models, toolless };
}

/**
 * The read, reused within a tab, with at most one request in the air.
 *
 * ⚠ **No `localStorage`, and `stale-if-error` is why.** Measured, the endpoint
 * answers `cache-control: public, max-age=300, stale-while-revalidate=3600,
 * stale-if-error=3600` — so the browser already serves a stale copy for an hour
 * after a failure and revalidates behind it. That is a cache this client does not
 * have to invalidate and therefore cannot get wrong, which is `fetchCatalogue`'s
 * argument one module over. A copy of our own would buy one case, a cold start
 * after an hour offline, and cost 34 KiB of somebody else's catalogue persisted on
 * a device plus a second source of truth for a list whose whole point is that it
 * is not written down here.
 *
 * ⚠ **A failure is never cached.** A read that did not land has to be retryable by
 * reopening the screen, so only `ok` is held.
 */
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
      // A refused `connect-src` lands here too, as a bare `TypeError` carrying no
      // status — which is why the sentence this becomes names neither.
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

/** Forgets the held read. For drivers, which must not inherit one run's cache. */
export function forgetOpenRouterModels(): void {
  cached = null;
  inflight = null;
}

/**
 * The one sentence a screen says when the list did not produce rows.
 *
 * ⚠ **It states the fact and names no remedy**, this app's standing rule for a
 * refusal, and here there genuinely is none on any screen: nobody in this product
 * configures this address. What it must not do is read as *the provider has
 * nothing* — an unread list and an empty one are different facts, which is why
 * the arms are separate rather than one string.
 *
 * Takes the display name rather than spelling it, because the name is the
 * daemon's; `customAgentSubline` is the same rule one file over.
 */
export function openRouterNotice(read: OpenRouterRead | null, displayName: string): string | null {
  if (read === null) return `Reading ${displayName}'s model list…`;
  if (read.kind === "ok") {
    return read.models.length === 0 ? `${displayName} lists no models that can use tools.` : null;
  }
  return `${displayName}'s model list could not be read on this device.`;
}
