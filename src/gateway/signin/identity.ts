import type { IdentityAnswer, IdentityTransport } from "./types.js";

const TIMEOUT_MS = 20_000;

async function answerOf(response: Response): Promise<IdentityAnswer> {
  let body: unknown = null;
  try {
    body = (await response.json()) as unknown;
  } catch {
    // Not JSON: the status is the whole answer.
    body = null;
  }
  return { status: response.status, body };
}

/** The one place this daemon speaks to a sign-in provider. A redirect is refused: it would carry a code or a refresh token to an address no flow named. */
export const REAL_IDENTITY: IdentityTransport = {
  async postForm(url, form, signal) {
    return answerOf(
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: "error",
      }),
    );
  },
  async getJson(url, signal) {
    return answerOf(
      await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: "error",
      }),
    );
  },
};
