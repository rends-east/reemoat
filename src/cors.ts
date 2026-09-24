/** CORS for the browser client, shared with the relay. Origin `*` is safe only because no credential is ever a cookie; never send Allow-Credentials. */

/** A literal list (a wildcard is ignored on credentialed requests) of every verb a route uses; daemoncheck and relaycheck assert it. */
export const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** `content-type` must be listed: it is what makes every JSON POST preflight. */
export const CORS_ALLOW_HEADERS = ["authorization", "content-type"] as const;

export const CORS_MAX_AGE_SECONDS = 600;

/** For a raw node:http response (the relay); the daemon mounts Hono's `cors()` with the same constants. */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS.join(", "),
    "access-control-allow-headers": CORS_ALLOW_HEADERS.join(", "),
    "access-control-max-age": String(CORS_MAX_AGE_SECONDS),
  };
}
