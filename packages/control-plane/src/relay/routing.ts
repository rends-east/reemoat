/** http: or https: only: the client derives ws/wss from the scheme, so a wss:// value would become plaintext ws. */
export function isBrowserReachable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type RelayUrlMap = Record<string, string>;

/** null when unset, "invalid" on any bad or duplicate entry. Splits on the first `=` only. */
export function parseRelayUrls(raw: string | undefined): RelayUrlMap | null | "invalid" {
  const text = (raw ?? "").trim();
  if (text.length === 0) return null;
  // Null-prototype so an id like `toString` is legal and never resolves to an inherited function.
  const out: RelayUrlMap = Object.create(null) as RelayUrlMap;
  for (const entry of text.split(",")) {
    const pair = entry.trim();
    if (pair.length === 0) continue;
    const split = pair.indexOf("=");
    if (split <= 0) return "invalid";
    const id = pair.slice(0, split).trim();
    const url = pair.slice(split + 1).trim();
    if (id.length === 0 || url.length === 0) return "invalid";
    if (Object.hasOwn(out, id)) return "invalid";
    if (!isBrowserReachable(url)) return "invalid";
    out[id] = url;
  }
  return Object.keys(out).length === 0 ? "invalid" : out;
}
