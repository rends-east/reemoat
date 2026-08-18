/**
 * How a relay is addressed, and which relay a machine is on.
 *
 * Two pure functions, in a file of their own for one reason: `main.ts` starts a
 * listener at module scope and mints a bootstrap admin, so nothing there can be
 * imported by a driver — and these are the only new *parsing* in the multi-relay
 * change. A rule that decides where a browser is sent, reachable by no test, is
 * the shape this repository refuses everywhere else.
 *
 * `app.ts` uses `isBrowserReachable` too, through `connectOrigins`: the CSP and
 * the routing have to agree about what counts as a relay URL, and agreeing by
 * copy is how they stop agreeing.
 */

/**
 * Whether a URL is one a *browser* can be handed for a machine.
 *
 * `http:`/`https:` and nothing else, and the reason is measured client
 * behaviour rather than tidiness. `packages/web/src/machine.ts` probes a route
 * with `fetch(new URL("/health", base))`, which throws on a `wss:` URL, and
 * `streamUrl` builds the socket by rewriting the scheme itself:
 *
 * ```ts
 * url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
 * ```
 *
 * So a `wss://` value does not fail loudly — it produces a **plaintext**
 * WebSocket. The one setting that looks more secure than the one that works,
 * carrying the caller's token in the clear.
 *
 * `new URL` alone is not this check: it accepts `r2.example:7889` with protocol
 * `r2.example:`, and `install.sh` writes `http://host:port` one variable over,
 * which makes a bare `host:port` the natural typo.
 */
export function isBrowserReachable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** What `REEMOAT_CP_RELAY_URLS` parsed to, or why it did not. */
export type RelayUrlMap = Record<string, string>;

/**
 * `<relay-id>=<url>` pairs, or `"invalid"`.
 *
 * A sentinel rather than a throw, so the caller reports it the way every other
 * setting in `main.ts` is reported: one `console.error` naming the variable, an
 * example, and `exit(2)`. Absent is `null` — the single-relay shape, where
 * `REEMOAT_CP_RELAY_URL` is the whole answer.
 *
 * **Duplicates are refused rather than resolved last-wins.** Two entries for one
 * slot is a copy-paste, and silently keeping the second sends every browser for
 * that relay to the wrong host with nothing said anywhere.
 *
 * The value may itself contain `=` — a query string is legal — so the split is
 * on the *first* one only.
 */
export function parseRelayUrls(raw: string | undefined): RelayUrlMap | null | "invalid" {
  const text = (raw ?? "").trim();
  if (text.length === 0) return null;
  // Null-prototype: a slot named `toString` must be a legal id rather than read
  // as already present, and must not resolve to an inherited function on the way
  // out — `c.json` drops a function field entirely.
  const out: RelayUrlMap = Object.create(null) as RelayUrlMap;
  for (const entry of text.split(",")) {
    const pair = entry.trim();
    if (pair.length === 0) continue;
    const split = pair.indexOf("=");
    if (split <= 0) return "invalid";
    const id = pair.slice(0, split).trim();
    const url = pair.slice(split + 1).trim();
    if (id.length === 0 || url.length === 0) return "invalid";
    // `Object.hasOwn`, never `out[id] !== undefined`: an id of `toString` would
    // otherwise read as already present and refuse a legal configuration — the
    // mirror of the prototype hazard `relayUrlFor` guards on the way out.
    if (Object.hasOwn(out, id)) return "invalid";
    if (!isBrowserReachable(url)) return "invalid";
    out[id] = url;
  }
  // A value that is nothing but separators — `","` — parsed to an empty map,
  // which would read as "one relay" while the operator clearly meant several.
  return Object.keys(out).length === 0 ? "invalid" : out;
}
