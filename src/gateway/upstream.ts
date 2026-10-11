import type { UpstreamTransport } from "./types.js";

/** The one place a model request leaves this daemon. A redirect is refused: it would carry somebody's key to an address no table named. */
export const REAL_UPSTREAM: UpstreamTransport = {
  async send(request) {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: "error",
    });
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      body: response.body,
    };
  },
};
