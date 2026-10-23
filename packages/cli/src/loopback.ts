import { ReemoatError } from "./errors.js";

/** A daemon on this computer, reached as the desktop app reaches its own: loopback, a bearer, no channel and no key (relay.md). */
export async function loopbackRequest(
  baseUrl: string,
  token: string,
  request: { method: string; path: string; headers: Record<string, string>; body: Uint8Array | null },
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  let response: Response;
  try {
    response = await fetcher(new URL(request.path, baseUrl), {
      method: request.method,
      // No Origin: a daemon refuses a page's request, and this is none.
      headers: { ...request.headers, authorization: `Bearer ${token}` },
      ...(request.body === null ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ReemoatError("client", 0, "unreachable", `no daemon answered at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
}
