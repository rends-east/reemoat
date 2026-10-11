import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { SignInError } from "./types.js";
import type { IdentityAnswer, IdentityTransport, SignInFlow } from "./types.js";

type Json = Record<string, unknown>;

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
/** What lets a request be paid for by the plan; a sign-in granted without it is an identity and nothing more. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** What a first sign-in is started as; the redirect hands back the client id this person's registration was issued. */
const REGISTRATION_CLIENT = "dynamic_agent_client";
const AGENT_NAME = "Reemoat";
/** Only the port may differ from one sign-in to the next: scheme, host and path are fixed at registration. */
const REDIRECT = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/auth\/callback$/;
const HOST_ID = /^(?:urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|urn:ietf:params:oauth:jwk-thumbprint:[a-z0-9-]+:[a-z0-9_-]+|did:key:[a-z0-9]+)$/i;
const MAX_HOST_ID_CHARS = 200;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** The only algorithm accepted, so a token naming another is refused before a key is fetched. */
const ID_TOKEN_ALG = "RS256";
const MIN_KEY_BITS = 2048;
const CLOCK_SKEW_MS = 5_000;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/i;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** What a refresh is answered with once its token is no longer one. */
const SIGNED_OUT = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const NOT_THIS_ATTEMPT = "This is not the answer to the sign-in that was started here. Start the sign-in again.";
const NOT_ANSWERING = "OpenAI's sign-in service is not answering. Try again shortly.";
const NO_KEYS = "OpenAI's signing keys could not be read, so the sign-in could not be checked. Try again shortly.";
const UNVERIFIED = "The identity ChatGPT sent back could not be verified, so nothing was signed in. Start the sign-in again.";
const NO_PLAN = "ChatGPT signed this account in without permission to use its plan here. Sign in again and allow plan usage.";

interface Grant {
  access: string;
  refresh: string;
  expiresAt: number;
  /** Null where the answer named none, which on a refresh leaves the grant as it was. */
  scopes: string[] | null;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(sentence: string): SignInError {
  return new SignInError("sign_in_malformed", sentence);
}

function unusable(field: string): SignInError {
  return malformed(`OpenAI's sign-in service answered without a usable ${field}.`);
}

function random(): string {
  return randomBytes(32).toString("base64url");
}

function same(one: string, other: string): boolean {
  const left = Buffer.from(one);
  const right = Buffer.from(other);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The one value a parameter came with; sent twice or empty, it is no answer. */
function only(values: string[]): string | null {
  const [first] = values;
  return values.length === 1 && first !== undefined && first !== "" ? first : null;
}

async function asked(call: () => Promise<IdentityAnswer>, signal: AbortSignal): Promise<IdentityAnswer> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SignInError) throw error;
    signal.throwIfAborted();
    // What a transport throws may quote what it was sending, so none of it is kept.
    throw new SignInError("sign_in_unreachable", NOT_ANSWERING);
  }
}

/** OAuth names its error in a string, the API in an object's code. */
function errorCode(body: unknown): string | null {
  if (!isObject(body)) return null;
  const error = body["error"];
  const code = typeof error === "string" ? error : isObject(error) ? error["code"] : body["code"];
  return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
}

function refusal(status: number, code: string | null): SignInError {
  if (status >= 500 || status === 429 || status === 408) return new SignInError("sign_in_unreachable", NOT_ANSWERING);
  return new SignInError("sign_in_refused", `OpenAI's sign-in service refused the request${code === null ? "" : ` (${code})`}.`);
}

function grantOf(body: unknown, now: number): Grant {
  if (!isObject(body)) throw malformed("OpenAI's sign-in service answered with something that is not a sign-in.");
  const text = (field: string): string => {
    const value = body[field];
    if (typeof value !== "string" || value === "") throw unusable(field);
    return value;
  };
  const access = text("access_token");
  const refresh = text("refresh_token");
  if (text("token_type").toLowerCase() !== "bearer") throw unusable("token_type");
  const seconds = body["expires_in"];
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) throw unusable("expires_in");
  const scope = body["scope"];
  if (scope !== undefined && typeof scope !== "string") throw unusable("scope");
  return { access, refresh, expiresAt: now + seconds * 1000, scopes: scope === undefined ? null : scope.split(/\s+/).filter(Boolean) };
}

function decoded(segment: string | undefined): unknown {
  if (segment === undefined || !SEGMENT.test(segment)) return null;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch {
    // Not JSON, so neither a token's header nor its claims.
    return null;
  }
}

async function signingKeys(transport: IdentityTransport, signal: AbortSignal): Promise<{ kid: unknown; key: KeyObject }[]> {
  const answer = await asked(() => transport.getJson(JWKS_URL, signal), signal);
  const listed = answer.status === 200 && isObject(answer.body) ? answer.body["keys"] : null;
  if (!Array.isArray(listed)) throw new SignInError("sign_in_unreachable", NO_KEYS);
  const keys: { kid: unknown; key: KeyObject }[] = [];
  for (const jwk of listed) {
    if (!isObject(jwk) || jwk["kty"] !== "RSA" || typeof jwk["n"] !== "string" || typeof jwk["e"] !== "string") continue;
    if ((jwk["use"] ?? "sig") !== "sig" || (jwk["alg"] ?? ID_TOKEN_ALG) !== ID_TOKEN_ALG) continue;
    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: "RSA", n: jwk["n"], e: jwk["e"] }, format: "jwk" });
    } catch {
      // A key this runtime cannot read is one nothing can be checked against.
      continue;
    }
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_KEY_BITS) keys.push({ kid: jwk["kid"], key });
  }
  return keys;
}

/** The claims of an ID token whose signature, issuer, audience, expiry and nonce all hold. */
async function identityOf(
  token: string,
  clientId: string,
  nonce: string,
  transport: IdentityTransport,
  now: number,
  signal: AbortSignal,
): Promise<Json> {
  const [head, body, mark, ...rest] = token.split(".");
  const header = decoded(head);
  const claims = decoded(body);
  if (rest.length > 0 || mark === undefined || !SEGMENT.test(mark) || !isObject(header) || !isObject(claims) || header["alg"] !== ID_TOKEN_ALG) {
    throw malformed(UNVERIFIED);
  }
  const keys = await signingKeys(transport, signal);
  const signed = Buffer.from(`${head}.${body}`);
  const signature = Buffer.from(mark, "base64url");
  const kid = header["kid"];
  if (!keys.some((entry) => (kid === undefined || entry.kid === kid) && verify("RSA-SHA256", signed, entry.key, signature))) {
    throw malformed(UNVERIFIED);
  }
  const audience = claims["aud"];
  const audiences: unknown[] = Array.isArray(audience) ? audience : [audience];
  const party = claims["azp"];
  const expires = claims["exp"];
  const returned = claims["nonce"];
  const subject = claims["sub"];
  if (
    claims["iss"] !== ISSUER ||
    !audiences.includes(clientId) ||
    (party === undefined ? audiences.length > 1 : party !== clientId) ||
    typeof expires !== "number" ||
    now >= expires * 1000 + CLOCK_SKEW_MS ||
    typeof returned !== "string" ||
    !same(returned, nonce) ||
    typeof subject !== "string" ||
    subject === ""
  ) {
    throw malformed(UNVERIFIED);
  }
  return claims;
}

function accountOf(claims: Json): string | null {
  for (const claim of ["email", "name"]) {
    const value = claims[claim];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

export const openaiSignIn: SignInFlow = {
  id: "openai-siwc",
  authorizeOrigin: ISSUER,

  begin({ redirectUri, hostId }) {
    const port = REDIRECT.exec(redirectUri)?.[1];
    if (port === undefined || Number(port) > 65535) {
      throw malformed("ChatGPT hands a sign-in back only to http://127.0.0.1:<port>/auth/callback on the computer the browser is on.");
    }
    if (hostId.length > MAX_HOST_ID_CHARS || !HOST_ID.test(hostId)) {
      throw malformed("This machine has no identifier ChatGPT accepts: a urn:uuid, a JWK thumbprint URN or a did:key.");
    }
    const state = random();
    const verifier = random();
    const nonce = random();
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: REGISTRATION_CLIENT,
      agent_name_hint: AGENT_NAME,
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { authorizeUrl: url.toString(), state, verifier, nonce, redirectUri, hostId };
  },

  async complete(attempt, redirected, transport, now, signal) {
    const state = only(redirected.getAll("state"));
    if (state === null || !same(state, attempt.state)) throw malformed(NOT_THIS_ATTEMPT);
    const refused = redirected.get("error");
    if (refused !== null) {
      throw new SignInError(
        "sign_in_refused",
        refused === "access_denied"
          ? "The sign-in was declined at ChatGPT, so nothing was signed in."
          : `ChatGPT did not complete the sign-in${ERROR_CODE.test(refused) ? ` (${refused})` : ""}.`,
      );
    }
    const code = only(redirected.getAll("code"));
    if (code === null) throw malformed("ChatGPT handed back no sign-in code. Start the sign-in again.");
    const clientId = only(redirected.getAll("client_id"));
    if (clientId === null || clientId === REGISTRATION_CLIENT || !CLIENT_ID.test(clientId)) {
      throw malformed("ChatGPT did not finish registering this machine. Start the sign-in again.");
    }

    const answer = await asked(
      () =>
        transport.postForm(
          TOKEN_URL,
          {
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirectUri,
            resource: RESOURCE,
          },
          signal,
        ),
      signal,
    );
    if (answer.status !== 200) throw refusal(answer.status, errorCode(answer.body));
    const grant = grantOf(answer.body, now);
    const idToken = isObject(answer.body) ? answer.body["id_token"] : undefined;
    if (typeof idToken !== "string") throw unusable("id_token");
    if (grant.scopes === null) throw unusable("scope");
    const claims = await identityOf(idToken, clientId, attempt.nonce, transport, now, signal);
    if (!grant.scopes.includes(PLAN_SCOPE)) throw new SignInError("sign_in_not_eligible", NO_PLAN);
    return { clientId, access: grant.access, refresh: grant.refresh, expiresAt: grant.expiresAt, account: accountOf(claims) };
  },

  async refresh(held, transport, now, signal) {
    const answer = await asked(
      () =>
        transport.postForm(
          TOKEN_URL,
          { grant_type: "refresh_token", client_id: held.clientId, refresh_token: held.refresh, resource: RESOURCE },
          signal,
        ),
      signal,
    );
    if (answer.status !== 200) {
      const code = errorCode(answer.body);
      if (code !== null && SIGNED_OUT.has(code)) return "signed_out";
      throw refusal(answer.status, code);
    }
    const grant = grantOf(answer.body, now);
    if (grant.scopes !== null && !grant.scopes.includes(PLAN_SCOPE)) throw new SignInError("sign_in_not_eligible", NO_PLAN);
    return { clientId: held.clientId, access: grant.access, refresh: grant.refresh, expiresAt: grant.expiresAt, account: held.account };
  },
};
