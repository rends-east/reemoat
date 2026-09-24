// POSIX single-quoting: controlPlaneUrl comes from the request's Host header, which can carry shell syntax.
// webcheck compares this body with the copy in the control plane's app.ts.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Must match enrollmentLines in cpctl.ts: webcheck extracts that top-level function's body and compares outputs over hostile URLs. */
export function enrollmentLines(controlPlaneUrl: string, code: string): string {
  return [
    "export REEMOAT_AUTH=signed",
    `export REEMOAT_CONTROL_PLANE=${shellQuote(controlPlaneUrl)}`,
    `export REEMOAT_ENROLL_CODE=${shellQuote(code)}`,
  ].join("\n");
}

/** The machines the install command runs on, never this client's own platform; webcheck holds it to bootstrap.sh's detect_platform. */
export const AGENT_HOST_OS = "macOS or Linux";

export function installCommand(controlPlaneUrl: string): string {
  // Uses this control plane's own origin rather than the README's release URL (Q4.112); one trailing slash is dropped.
  const origin = controlPlaneUrl.endsWith("/") ? controlPlaneUrl.slice(0, -1) : controlPlaneUrl;
  return `curl -fsSL ${shellQuote(`${origin}/install.sh`)} | sh`;
}

export function enrollmentExpiryText(expiresAt: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "expires in under a minute";
  if (minutes < 60) return `expires in ${minutes}m`;
  return `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
