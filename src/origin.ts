// Which web pages may speak to this listener: the app's own document, and one served from this computer (Q1.655).
// A browser writes Origin itself and a page cannot forge it; a caller that sends none is a program and not a page.

/** Where the shell serves the app from: its own scheme on macOS and Linux, this host on Windows and Android. */
export const SHELL_ORIGINS: readonly string[] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `null` is what a sandboxed or file page sends, and is refused with every other foreign one. */
export function pageOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (SHELL_ORIGINS.includes(origin)) return true;
  // The shell in development is Vite's page on this computer; no page from elsewhere can claim a loopback origin.
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.origin === origin && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** A name rebound to this address keeps its own Host, and a same-origin GET carries no Origin to refuse. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** REEMOAT_HOST as configured: whether only this computer can reach the listener. */
export function bindIsLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
