/**
 * What address a request appears to come from — and how much of it is evidence.
 *
 * ⚠ **This docblock used to say "two callers, both of which only ever *print*
 * the answer … nothing authorizes on it, and nothing may start to."** Every
 * clause of that was false by the time it was read. There are more callers than
 * two, and one of them is `throttle.ts`, where this value is half of `loginKey`
 * and the whole of `addressKey` — and a `429` is a refusal, which is a decision
 * whatever the sentence above preferred to call it. The stale comment is what
 * kept the hole below unexamined, which is this file's own version of the
 * `owned` → `sessionOf` rename: a property the code appears to have and nothing
 * enforces is worse than one it visibly lacks.
 *
 * **So `x-forwarded-for` is now read only as far as it is configured to be
 * trusted.** `REEMOAT_CP_TRUSTED_PROXY_HOPS` is how many proxies of your own sit
 * in front of this service, and it defaults to **zero** — the header is ignored
 * outright and the socket is the answer. What that closes: with the header
 * honoured unconditionally *and read from the left*, the address half of every
 * throttle key was a string the caller typed. Rotating it defeated the login
 * counter and the per-address backstop together, and spelling somebody else's
 * address into it **aimed** them — thirty failed sign-ins naming a victim's IP
 * refused that address its own sign-in, and its own `POST /v1/forgot`, for
 * fifteen minutes, with no credential and no name known.
 *
 * **Counted from the right, because that is the end your own proxy wrote.** Every
 * ordinary reverse proxy *appends*, so the leftmost entry is whatever the client
 * sent and the rightmost is what the hop nearest this service observed. Reading
 * the left was the defect; reading the right with a configured hop count is the
 * only arrangement that is a fact rather than a suggestion. Fewer entries than
 * hops means the request did not come through the proxy the operator described,
 * so the socket answers instead.
 *
 * The value is still not an *identity*. Somebody who has stolen a session token
 * arrives from wherever they are, and `user_session_origins` is a way to **end**
 * sessions rather than to judge them. What it now is, is a value the caller
 * cannot choose — which is all a rate limiter ever needed.
 */

/**
 * How much of an address to keep.
 *
 * `x-forwarded-for` is caller-supplied and unbounded, and the value lands in a
 * database and then on a page. IPv6 with a zone id is 45-odd characters, so this
 * is generous by a factor of two and still a bound.
 *
 * Exported because two other modules bound the same value and both used to
 * restate the literal: `sessions.ts` clamps it again on the way into
 * `user_session_origins`, and `throttle.ts` bounds it as half of a composed key.
 * One number, one home — the alternative is three 64s that agree until somebody
 * changes one.
 */
export const MAX_ADDRESS_CHARS = 64;

/**
 * How many proxies of your own stand in front of this service.
 *
 * Zero is the default and means "none": ignore `x-forwarded-for` completely.
 * That is the safe answer everywhere, and the *wrong* answer for the shape
 * `install.sh` recommends — publishing on `127.0.0.1` with a TLS proxy in front
 * — where it collapses every caller onto the proxy's address and puts them in
 * one throttle bucket. So it is asked at install time and warned about at
 * runtime, rather than guessed from the bind address, which is not evidence of
 * anything.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/**
 * Whether a request carried a forwarding header this service is ignoring.
 *
 * The one thing a caller cannot be told and an operator must be: with hops at
 * zero and a proxy really in front, every counter here is keyed on that proxy,
 * and the symptom — one person's failed sign-ins refusing everybody else's — is
 * not one anybody would trace back to a missing environment variable. `main.ts`
 * prints it once.
 */
export function forwardingIgnored(forwardedFor: string | undefined, trustedHops: number): boolean {
  return trustedHops <= 0 && (forwardedFor ?? "").trim().length > 0;
}

/**
 * The address to record, from the forwarding header and the socket.
 *
 * **The socket wins unless a hop count says otherwise**, and it used to be the
 * other way round with the header read from the left — see the header of this
 * file for what that cost. The order here is the whole of the fix: a value the
 * caller can choose is not a rate-limit key.
 *
 * `trustedHops` entries are counted **from the right**, because that is the end
 * your own proxy appends to. One trusted hop takes the last entry; two takes the
 * second-to-last, which is what a proxy behind a CDN looks like. A header with
 * fewer entries than the operator described did not come through the proxy they
 * described, so it is refused in favour of the socket rather than partially
 * believed.
 *
 * Node reports an IPv4 client on a dual-stack listener as `::ffff:10.0.0.5`. The
 * prefix is stripped, because the thing a person is trying to do with this value
 * is recognise their own network.
 *
 * Pure, so `relaycheck` can assert every branch without a socket.
 */
export function callerAddressOf(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  trustedHops: number = DEFAULT_TRUSTED_PROXY_HOPS,
): string {
  const chosen = trustedFrom(forwardedFor, trustedHops) ?? (remoteAddress ?? "").trim();
  if (chosen.length === 0) return "unknown";
  const unmapped = chosen.startsWith("::ffff:") ? chosen.slice("::ffff:".length) : chosen;
  return unmapped.slice(0, MAX_ADDRESS_CHARS);
}

/** The entry `trustedHops` from the right, or `null` for "do not believe this". */
function trustedFrom(forwardedFor: string | undefined, trustedHops: number): string | null {
  if (trustedHops <= 0) return null;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Strictly fewer entries than hops means this request did not traverse the
  // chain the operator described. Believing the leftmost anyway is exactly the
  // read this function was rewritten to stop making.
  if (entries.length < trustedHops) return null;
  return entries[entries.length - trustedHops] ?? null;
}
