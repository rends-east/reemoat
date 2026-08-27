/**
 * Cross-origin access, for the browser client and nothing else.
 *
 * Every connection a browser makes to a daemon is cross-origin — the UI is served
 * by the control plane, the daemon answers on its own host, and the relay is a
 * third origin again. Without this a browser cannot `fetch` a daemon *at all*, on
 * either path: every mutating call sends `content-type: application/json`, so
 * every one of them preflights.
 *
 * **The origin is `*`, and the reason is that there are no cookies in this
 * system.** The credential is always an explicit `Authorization` header or an
 * explicit `?token=`; nothing is ever sent by the browser on its own initiative.
 * A wildcard therefore grants a hostile page exactly what it already had with
 * `curl` — it does not, as it would in a cookie-bearing design, hand that page the
 * user's identity. `Access-Control-Allow-Credentials` is deliberately never sent:
 * the wildcard and credentials are individually harmless and jointly the thing
 * that actually goes wrong, and the browser refuses the combination anyway.
 *
 * Shared with the relay, which has to answer preflights itself and must answer
 * them the same way. Same import direction as `relay/protocol.ts` — the control
 * plane may read this file, nothing here may read the control plane.
 */

/**
 * Every method any route uses, plus OPTIONS.
 *
 * A literal list rather than a wildcard: `Access-Control-Allow-Methods: *` is
 * ignored by a browser whenever the request is credentialed, and a header that
 * works until someone adds one flag is worse than one that always works.
 *
 * `PUT` is here because `PUT /agent-auth/:agent` exists, and this list said
 * otherwise for two releases: the paste-a-token path preflight-failed in every
 * browser while working perfectly from `curl`, which is the exact failure mode a
 * literal list is supposed to prevent rather than cause.
 *
 * `PATCH` is here for `PATCH /custom-agents/:id`, the one route that edits a row
 * in place under the id it already has, and it arrived by the same door: the
 * route shipped first and this list did not move, so editing an assembled agent
 * failed its preflight in every browser and nowhere else. It is the whole reason
 * the verb is available at all — `POST /sessions/:id/meta` says so where it
 * explains why it did not take it.
 *
 * "Every method any route uses" is a claim this file cannot check, so two drivers
 * check it from the two sides. `pnpm daemoncheck` mounts the real app and asserts
 * no registered route uses a verb this list withholds — that direction is the one
 * that breaks a client, and it is the only place the routes and the list are both
 * in scope. `pnpm relaycheck` asserts the relay answers a preflight with exactly
 * this set, because the relay and the daemon must not disagree about the same API.
 */
export const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * `authorization` is the credential. `content-type` is what makes every POST a
 * preflighted request in the first place — without it in this list, creating a
 * session fails while listing them succeeds, which is a confusing way to find out.
 */
export const CORS_ALLOW_HEADERS = ["authorization", "content-type"] as const;

/** How long a browser may cache a preflight. Ten minutes: long enough that a phone
 *  polling every few seconds preflights approximately never, short enough that a
 *  change here reaches a client the same day. */
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * The headers, ready to write onto a raw `node:http` response.
 *
 * The daemon does not use this — it mounts Hono's `cors()` middleware with the
 * constants above, because that also handles the preflight short-circuit. The
 * relay does, because it is raw `node:http` and has no middleware stack.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS.join(", "),
    "access-control-allow-headers": CORS_ALLOW_HEADERS.join(", "),
    "access-control-max-age": String(CORS_MAX_AGE_SECONDS),
  };
}
