// POSIX single-quoting: an origin can carry shell syntax, and so can a code.
// webcheck compares this body with the copies in the control plane's app.ts and in cpctl.ts.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The machines the install command runs on, never this client's own platform; webcheck holds it to bootstrap.sh's detect_platform. */
export const AGENT_HOST_OS = "macOS or Linux";

/** With a code the installer signs in to nothing and finishes, or repairs, the install on the host it is run on (Q3.428). */
export function installCommand(controlPlaneUrl: string, code?: string): string {
  // Uses this control plane's own origin rather than the README's release URL (Q4.112); one trailing slash is dropped.
  const origin = controlPlaneUrl.endsWith("/") ? controlPlaneUrl.slice(0, -1) : controlPlaneUrl;
  const fetched = `curl -fsSL ${shellQuote(`${origin}/install.sh`)} | sh`;
  return code === undefined ? fetched : `${fetched} -s -- --enroll-code ${shellQuote(code)}`;
}

export function enrollmentExpiryText(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "expires in under a minute";
  if (minutes < 60) return `expires in ${minutes}m`;
  return `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
