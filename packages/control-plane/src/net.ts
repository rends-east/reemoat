// The caller's address keys the throttles, so x-forwarded-for is believed only as far as REEMOAT_CP_TRUSTED_PROXY_HOPS says.

export const MAX_ADDRESS_CHARS = 64;

/** Zero ignores x-forwarded-for. Behind a TLS proxy that puts every caller in one throttle bucket, so install asks and main.ts warns. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

export function forwardingIgnored(forwardedFor: string | undefined, trustedHops: number): boolean {
  return trustedHops <= 0 && (forwardedFor ?? "").trim().length > 0;
}

/** The socket wins unless a hop count says otherwise; entries count from the right, the end your own proxy appends to. */
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

function trustedFrom(forwardedFor: string | undefined, trustedHops: number): string | null {
  if (trustedHops <= 0) return null;
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Fewer entries than hops: the request did not come through the configured chain.
  if (entries.length < trustedHops) return null;
  return entries[entries.length - trustedHops] ?? null;
}
