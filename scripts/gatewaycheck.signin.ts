import { constants, createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { shapeForChatgptPlan } from "../src/gateway/shape/chatgpt.js";
import { openaiSignIn } from "../src/gateway/signin/openai.js";
import { SignInError } from "../src/gateway/signin/types.js";
import type { IdentityAnswer, IdentityTransport, SignInAttempt, SignInTokens } from "../src/gateway/signin/types.js";

// The sign-in half of gatewaycheck: OpenAI's "Sign in with ChatGPT" flow against a stand-in for its identity service, with keys made here, and the shape a plan's requests are held to.

type Check = (name: string, got: unknown, want: unknown) => void;
type Json = Record<string, unknown>;

const AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
const TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const GRANTED = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";
const HOST = "urn:uuid:3f1c2a9e-5b7d-4c1e-9a2f-0d6b8e4c7a11";
const CLIENT = "oaiapp_probe-1";
const KID = "probe-key";
const NOW = 1_790_000_000_000;

const CODE = "code-never-said";
const ACCESS = "access-never-said";
const REFRESH = "refresh-never-said";
const ACCESS_2 = "second-access-never-said";
const REFRESH_2 = "second-refresh-never-said";

const SIGNED_OUT = ["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"];
const DROPPED = [
  "background",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
];
const KEPT_AT_VENDOR = ["previous_response_id", "conversation", "prompt"];
const HOSTED = ["image_generation", "file_search", "code_interpreter", "computer", "computer_use", "computer_use_preview", "mcp", "tool_search", "programmatic_tool_calling"];

const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });

interface Call {
  via: "post" | "get";
  url: string;
  form?: Record<string, string>;
}

interface Stand {
  transport: IdentityTransport;
  calls: Call[];
}

/** Every refusal the run produced, for the one check that reads them all. */
const said: SignInError[] = [];

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key order is nobody's contract. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canon(value[key])]),
  );
}

function jwk(key: KeyObject, extra: Json = {}): Json {
  return { ...key.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig", ...extra };
}

function keySet(...keys: Json[]): IdentityAnswer {
  return { status: 200, body: { keys } };
}

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(claims: Json, header: Json = {}, mark?: (signed: string) => string): string {
  const signed = `${part({ alg: "RS256", typ: "JWT", kid: KID, ...header })}.${part(claims)}`;
  return `${signed}.${mark === undefined ? sign("RSA-SHA256", Buffer.from(signed), signer.privateKey).toString("base64url") : mark(signed)}`;
}

function signedBy(key: KeyObject): (signed: string) => string {
  return (signed) => sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url");
}

function pss(signed: string): string {
  return sign("sha256", Buffer.from(signed), { key: signer.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64url");
}

function claimsFor(attempt: SignInAttempt, extra: Json = {}): Json {
  return {
    iss: "https://auth.openai.com",
    aud: CLIENT,
    sub: "subject-1",
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
    nonce: attempt.nonce,
    email: "person@example.com",
    name: "A Person",
    ...extra,
  };
}

function without(value: Json, ...fields: string[]): Json {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}

function granted(token: string, extra: Json = {}): IdentityAnswer {
  return {
    status: 200,
    body: { access_token: ACCESS, refresh_token: REFRESH, id_token: token, token_type: "Bearer", expires_in: 3600, scope: GRANTED, earliest_refresh_at: NOW / 1000 + 1800, ...extra },
  };
}

function refreshed(extra: Json = {}): IdentityAnswer {
  return { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, token_type: "Bearer", expires_in: 1800, scope: GRANTED, ...extra } };
}

/** "down" is a transport that fails and quotes what it was sending, as a careless one would. */
function stand(token: IdentityAnswer | "down", keys: IdentityAnswer | "down" = keySet(jwk(signer.publicKey))): Stand {
  const calls: Call[] = [];
  const answer = async (value: IdentityAnswer | "down", sending: string): Promise<IdentityAnswer> => {
    if (value === "down") throw new Error(`ECONNREFUSED while sending ${sending}`);
    return value;
  };
  return {
    calls,
    transport: {
      postForm: (url, form) => {
        calls.push({ via: "post", url, form });
        return answer(token, JSON.stringify(form));
      },
      getJson: (url) => {
        calls.push({ via: "get", url });
        return answer(keys, url);
      },
    },
  };
}

function handedBack(attempt: SignInAttempt, change: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams({ code: CODE, scope: GRANTED, state: attempt.state, client_id: CLIENT });
  for (const [name, value] of Object.entries(change)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  return params;
}

/** What a call came to: its value, the code of its refusal, or the name of anything else it threw. */
async function outcome<T>(run: () => T | Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof SignInError)) return `threw ${error instanceof Error ? error.name : typeof error}`;
    said.push(error);
    return error.code;
  }
}

function begun(redirectUri = REDIRECT, hostId = HOST): Promise<SignInAttempt | string> {
  return outcome(() => openaiSignIn.begin({ redirectUri, hostId }));
}

function shaped(body: unknown): unknown {
  const result = shapeForChatgptPlan(body);
  return "body" in result ? canon(result.body) : result.untranslatable;
}

function refusedFor(body: unknown): string {
  const result = shapeForChatgptPlan(body);
  return "untranslatable" in result ? result.untranslatable : "";
}

export async function signInChecks(check: Check): Promise<void> {
  const attempt = openaiSignIn.begin({ redirectUri: REDIRECT, hostId: HOST });
  const live = new AbortController().signal;
  const good = idToken(claimsFor(attempt));

  const completed = async (redirected: URLSearchParams, token: IdentityAnswer | "down", keys?: IdentityAnswer | "down"): Promise<{ came: unknown; calls: Call[] }> => {
    const { transport, calls } = stand(token, keys);
    return { came: await outcome(() => openaiSignIn.complete(attempt, redirected, transport, NOW, live)), calls };
  };
  const identified = async (token: string, keys?: IdentityAnswer | "down"): Promise<unknown> => {
    const came = (await completed(handedBack(attempt), granted(token), keys)).came;
    return isObject(came) ? "signed in" : came;
  };

  process.stdout.write("\nsign in with ChatGPT: the page a person is sent to\n");
  {
    const url = new URL(attempt.authorizeUrl);
    check("the flow names itself and the one origin a client may open", [openaiSignIn.id, openaiSignIn.authorizeOrigin], ["openai-siwc", "https://auth.openai.com"]);
    check("the page is OpenAI's authorize endpoint, on that origin", [`${url.origin}${url.pathname}`, url.origin === openaiSignIn.authorizeOrigin], [AUTHORIZE, true]);
    check(
      "it carries every parameter of a first registration, and no other",
      canon(Object.fromEntries(url.searchParams)),
      canon({
        client_id: "dynamic_agent_client",
        agent_name_hint: "Reemoat",
        ext_agent_host_id: HOST,
        response_type: "code",
        redirect_uri: REDIRECT,
        scope: SCOPE,
        resource: RESOURCE,
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
      }),
    );
    check("each of them once, and the verifier itself nowhere", [[...url.searchParams.keys()].length, attempt.authorizeUrl.includes(attempt.verifier)], [11, false]);
    check("every value is encoded: no raw space, and the redirect's own colons and slashes are escaped", [/\s/.test(attempt.authorizeUrl), url.search.includes("redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback")], [false, true]);
    check("the attempt keeps where the page hands back and which machine asked", [attempt.redirectUri, attempt.hostId], [REDIRECT, HOST]);
    check(
      "state, nonce and verifier are 256 random bits each, in the characters PKCE allows",
      [attempt.state, attempt.nonce, attempt.verifier].map((value) => /^[A-Za-z0-9_-]{43}$/.test(value)),
      [true, true, true],
    );
    const second = openaiSignIn.begin({ redirectUri: REDIRECT, hostId: HOST });
    check(
      "and are new for every attempt, and never one another",
      [new Set([attempt.state, attempt.nonce, attempt.verifier, second.state, second.nonce, second.verifier]).size, second.hostId],
      [6, HOST],
    );
    check("another port on the same loopback path is the same redirect", isObject(await begun("http://127.0.0.1:54321/auth/callback")), true);
    const elsewhere = [
      "http://localhost:1455/auth/callback",
      "https://127.0.0.1:1455/auth/callback",
      "http://127.0.0.1:1455/callback",
      "http://127.0.0.1:1455/auth/callback/",
      "http://127.0.0.1:1455/auth/callback?next=1",
      "http://127.0.0.1/auth/callback",
      "http://127.0.0.1:70000/auth/callback",
      "http://[::1]:1455/auth/callback",
      "http://192.168.1.20:1455/auth/callback",
      "https://reemoat.example/auth/callback",
    ];
    check("no other redirect is begun with: another host, scheme, path, a query, no port", await Promise.all(elsewhere.map((uri) => begun(uri))), elsewhere.map(() => "sign_in_malformed"));
    const hosts = ["urn:uuid:3F1C2A9E-5B7D-4C1E-9A2F-0D6B8E4C7A11", "urn:ietf:params:oauth:jwk-thumbprint:sha-256:NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"];
    check("a host is a urn:uuid, a JWK thumbprint URN or a did:key", (await Promise.all(hosts.map((host) => begun(REDIRECT, host)))).map(isObject), hosts.map(() => true));
    const strangers = ["3f1c2a9e-5b7d-4c1e-9a2f-0d6b8e4c7a11", "person@example.com", "did:web:example.com", "urn:uuid:not-a-uuid", "", `did:key:${"z".repeat(300)}`];
    check("and nothing that could name a person", await Promise.all(strangers.map((host) => begun(REDIRECT, host))), strangers.map(() => "sign_in_malformed"));
  }

  process.stdout.write("\nsign in with ChatGPT: what the redirect hands back\n");
  {
    const happy = await completed(handedBack(attempt), granted(good));
    const want: SignInTokens = { clientId: CLIENT, access: ACCESS, refresh: REFRESH, expiresAt: NOW + 3_600_000, account: "person@example.com" };
    check("a finished sign-in holds the issued client, both tokens, the expiry and the account's email", happy.came, want);
    check("the code is exchanged at the token endpoint under the issued client, then the keys are read", happy.calls, [
      {
        via: "post",
        url: TOKEN,
        form: { grant_type: "authorization_code", client_id: CLIENT, code: CODE, code_verifier: attempt.verifier, redirect_uri: REDIRECT, resource: RESOURCE },
      },
      { via: "get", url: JWKS },
    ]);
    check("a redirect that names no scope is still one: what was granted is the token answer's to say", (await completed(handedBack(attempt, { scope: null }), granted(good))).came, want);
    const accounts = await Promise.all(
      [without(claimsFor(attempt), "email"), without(claimsFor(attempt), "email", "name"), claimsFor(attempt, { email: "  ", name: 7 })].map(
        async (claims) => ((await completed(handedBack(attempt), granted(idToken(claims)))).came as SignInTokens).account,
      ),
    );
    check("with no email the account is the name, and with neither it is nobody, never the subject", accounts, ["A Person", null, null]);

    const strays: [string, Record<string, string | null>][] = [
      ["another state", { state: "x".repeat(43) }],
      ["no state", { state: null }],
      ["an empty state", { state: "" }],
    ];
    const stray = await Promise.all(strays.map(([, change]) => completed(handedBack(attempt, change), granted(good))));
    check("a redirect that is not this attempt's is refused: another state, none, an empty one", stray.map((one) => one.came), strays.map(() => "sign_in_malformed"));
    check("and nothing is sent for it", stray.flatMap((one) => one.calls), []);
    const twice = handedBack(attempt);
    twice.append("state", attempt.state);
    check("a state sent twice is no state", (await completed(twice, granted(good))).came, "sign_in_malformed");

    const declined = await completed(handedBack(attempt, { error: "access_denied", code: null }), granted(good));
    check("a sign-in declined at the page is a refusal, and no code is exchanged", [declined.came, declined.calls], ["sign_in_refused", []]);
    const failed = await completed(handedBack(attempt, { error: "server_error" }), granted(good));
    check("any other error from the page is one too, a code beside it or not", [failed.came, failed.calls], ["sign_in_refused", []]);
    check("but the state is read first: an error under another state is not this attempt's", (await completed(handedBack(attempt, { error: "access_denied", state: "y".repeat(43) }), granted(good))).came, "sign_in_malformed");

    const codeless = await Promise.all([{ code: null }, { code: "" }].map((change) => completed(handedBack(attempt, change), granted(good))));
    check("a redirect with no code is malformed, and nothing is sent", [codeless.map((one) => one.came), codeless.flatMap((one) => one.calls)], [["sign_in_malformed", "sign_in_malformed"], []]);
    const doubled = handedBack(attempt);
    doubled.append("code", "another");
    check("as is one with two", (await completed(doubled, granted(good))).came, "sign_in_malformed");
    const unregistered = await Promise.all(
      [{ client_id: null }, { client_id: "dynamic_agent_client" }, { client_id: "oaiapp bad" }, { client_id: "" }].map((change) => completed(handedBack(attempt, change), granted(good))),
    );
    check(
      "a first sign-in that hands back no issued client is an unfinished registration: none, the registration name itself, one that is no id",
      [unregistered.map((one) => one.came), unregistered.flatMap((one) => one.calls)],
      [unregistered.map(() => "sign_in_malformed"), []],
    );
  }

  process.stdout.write("\nsign in with ChatGPT: what the token endpoint answers\n");
  {
    const fields = ["access_token", "refresh_token", "id_token", "token_type", "expires_in", "scope"];
    const missing = await Promise.all(fields.map((field) => completed(handedBack(attempt), { status: 200, body: without(granted(good).body as Json, field) })));
    check("an answer missing any of its six fields is malformed", missing.map((one) => one.came), fields.map(() => "sign_in_malformed"));
    const wrong: Json[] = [{ expires_in: "3600" }, { expires_in: 0 }, { expires_in: -5 }, { token_type: "mac" }, { access_token: "" }, { refresh_token: 7 }, { scope: ["openid"] }, { id_token: null }];
    check(
      "as is one whose field is the wrong kind of thing",
      (await Promise.all(wrong.map((extra) => completed(handedBack(attempt), granted(good, extra))))).map((one) => one.came),
      wrong.map(() => "sign_in_malformed"),
    );
    const unread = await Promise.all([null, "ok", [1]].map((body) => completed(handedBack(attempt), { status: 200, body })));
    check("and one that is not an object at all", unread.map((one) => one.came), ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed"]);
    check("the token type is a bearer in any case", (await completed(handedBack(attempt), granted(good, { token_type: "bearer" }))).came !== "sign_in_malformed", true);

    const refusals: IdentityAnswer[] = [
      { status: 400, body: { error: "invalid_grant", error_description: `the code ${CODE} was used` } },
      { status: 401, body: { error: "invalid_client" } },
      { status: 400, body: null },
      { status: 403, body: { error: { code: "forbidden", message: ACCESS } } },
    ];
    const refused = await Promise.all(refusals.map((answer) => completed(handedBack(attempt), answer)));
    check("a code the endpoint will not take is a refusal, whatever it says", refused.map((one) => one.came), refusals.map(() => "sign_in_refused"));
    check("and no key is read for a sign-in that did not happen", refused.flatMap((one) => one.calls.filter((call) => call.via === "get")), []);
    const away: (IdentityAnswer | "down")[] = [{ status: 500, body: null }, { status: 503, body: { error: "unavailable" } }, { status: 429, body: null }, "down"];
    check(
      "an endpoint that fails, throttles or cannot be reached is unreachable",
      (await Promise.all(away.map((answer) => completed(handedBack(attempt), answer)))).map((one) => one.came),
      away.map(() => "sign_in_unreachable"),
    );
    const stopped = new AbortController();
    stopped.abort();
    const dropped = stand("down");
    check("a caller that gave up is told so, not that OpenAI was unreachable", await outcome(() => openaiSignIn.complete(attempt, handedBack(attempt), dropped.transport, NOW, stopped.signal)), "threw AbortError");

    const identityOnly = "email offline_access openid profile";
    check("a sign-in granted without the plan's permission is not one this can spend", (await completed(handedBack(attempt), granted(good, { scope: identityOnly }))).came, "sign_in_not_eligible");
    check("though the redirect claimed it", (await completed(handedBack(attempt, { scope: GRANTED }), granted(good, { scope: identityOnly }))).came, "sign_in_not_eligible");
  }

  process.stdout.write("\nsign in with ChatGPT: the identity token\n");
  {
    check("a token the issuer's key signed is an identity", await identified(good), "signed in");
    check("one another key signed under the same key id is not", await identified(idToken(claimsFor(attempt), {}, signedBy(stranger.privateKey))), "sign_in_malformed");
    const [head, , mark] = good.split(".");
    check("nor one whose claims were changed after signing", await identified(`${head}.${part(claimsFor(attempt, { email: "other@example.com" }))}.${mark}`), "sign_in_malformed");
    check("nor one cut short of its signature", await identified(`${head}.${part(claimsFor(attempt))}.${String(mark).slice(0, -4)}`), "sign_in_malformed");

    const audiences: [unknown, Json, string][] = [
      ["oaiapp_other", {}, "sign_in_malformed"],
      [[CLIENT], {}, "signed in"],
      [[CLIENT, "oaiapp_other"], { azp: CLIENT }, "signed in"],
      [[CLIENT, "oaiapp_other"], {}, "sign_in_malformed"],
      [CLIENT, { azp: "oaiapp_other" }, "sign_in_malformed"],
      ["dynamic_agent_client", {}, "sign_in_malformed"],
      [undefined, {}, "sign_in_malformed"],
    ];
    check(
      "the audience is the issued client: another, several with no authorized party, another party and none are refused",
      await Promise.all(audiences.map(([aud, extra]) => identified(idToken(claimsFor(attempt, { aud, ...extra }))))),
      audiences.map(([, , want]) => want),
    );
    check(
      "the nonce is this attempt's: another, none and one that is no string are refused",
      await Promise.all([{ nonce: "z".repeat(43) }, { nonce: undefined }, { nonce: 7 }].map((extra) => identified(idToken(claimsFor(attempt, extra))))),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );
    const expiries: [unknown, string][] = [
      [NOW / 1000 - 60, "sign_in_malformed"],
      [NOW / 1000 - 5, "sign_in_malformed"],
      [NOW / 1000 - 4, "signed in"],
      [undefined, "sign_in_malformed"],
      [String(NOW / 1000 + 3600), "sign_in_malformed"],
    ];
    check(
      "an expired token is refused, five seconds of skew allowed and no more, and so is one that says no expiry",
      await Promise.all(expiries.map(([exp]) => identified(idToken(claimsFor(attempt, { exp }))))),
      expiries.map(([, want]) => want),
    );
    check(
      "the issuer is OpenAI's, to the character",
      await Promise.all(["https://auth.openai.com/", "https://auth.openai.com.example", "http://auth.openai.com", undefined].map((iss) => identified(idToken(claimsFor(attempt, { iss }))))),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );
    check(
      "and it names a subject",
      await Promise.all([{ sub: undefined }, { sub: "" }, { sub: 7 }].map((extra) => identified(idToken(claimsFor(attempt, extra))))),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );

    const unsigned = await completed(handedBack(attempt), granted(idToken(claimsFor(attempt), { alg: "none" }, () => "")));
    const secret = signer.publicKey.export({ type: "spki", format: "pem" });
    const keyed = await completed(handedBack(attempt), granted(idToken(claimsFor(attempt), { alg: "HS256" }, (signed) => createHmac("sha256", secret).update(signed).digest("base64url"))));
    const padded = await completed(handedBack(attempt), granted(idToken(claimsFor(attempt), { alg: "PS256" }, pss)));
    check(
      "only RS256 is an algorithm: none, a MAC keyed with the public key and the same key under PSS are refused",
      [unsigned.came, keyed.came, padded.came],
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );
    check("before any key is read", [unsigned, keyed, padded].flatMap((one) => one.calls.filter((call) => call.via === "get")), []);
    check(
      "a header that names another algorithm, or none, is refused over a signature RS256 would accept",
      await Promise.all(["RS512", "PS256", "none", "rs256", undefined].map((alg) => identified(idToken(claimsFor(attempt), { alg })))),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );
    check(
      "and a header that says RS256 over another algorithm's signature is refused by the signature",
      await Promise.all([identified(idToken(claimsFor(attempt), {}, pss)), identified(idToken(claimsFor(attempt), {}, () => "AAAA"))]),
      ["sign_in_malformed", "sign_in_malformed"],
    );
    check(
      "a token is three parts",
      await Promise.all([identified(`${head}.${part(claimsFor(attempt))}`), identified(`${good}.extra`), identified("not-a-token"), identified(`${head}.!!!.${mark}`)]),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );

    check("a key id the issuer does not publish verifies nothing", await identified(idToken(claimsFor(attempt), { kid: "another-key" })), "sign_in_malformed");
    check("a token naming no key is checked against every key published", await identified(idToken(claimsFor(attempt), { kid: undefined }), keySet(jwk(stranger.publicKey, { kid: "old" }), jwk(signer.publicKey))), "signed in");
    check("the right key among several is found by its id", await identified(good, keySet(jwk(stranger.publicKey, { kid: "old" }), { kty: "EC", crv: "P-256", kid: KID }, jwk(signer.publicKey))), "signed in");
    const unfit: [string, IdentityAnswer][] = [
      ["for encryption", keySet(jwk(signer.publicKey, { use: "enc" }))],
      ["for another algorithm", keySet(jwk(signer.publicKey, { alg: "PS256" }))],
      ["not RSA", keySet({ ...jwk(signer.publicKey), kty: "oct" })],
      ["unreadable", keySet({ kty: "RSA", kid: KID, n: "!", e: "AQAB" })],
      ["absent", keySet()],
    ];
    check("a published key that is for something else, or is no key, verifies nothing", await Promise.all(unfit.map(([, keys]) => identified(good, keys))), unfit.map(() => "sign_in_malformed"));
    check("nor does a key shorter than 2048 bits, signature and all", await identified(idToken(claimsFor(attempt), {}, signedBy(weak.privateKey)), keySet(jwk(weak.publicKey))), "sign_in_malformed");
    const keyless: (IdentityAnswer | "down")[] = ["down", { status: 503, body: null }, { status: 200, body: null }, { status: 200, body: { keys: "none" } }, { status: 404, body: { keys: [jwk(signer.publicKey)] } }];
    check("keys that cannot be read are an outage, not a forged identity", await Promise.all(keyless.map((keys) => identified(good, keys))), keyless.map(() => "sign_in_unreachable"));
  }

  process.stdout.write("\nsign in with ChatGPT: keeping a sign-in\n");
  {
    const held: SignInTokens = { clientId: CLIENT, access: ACCESS, refresh: REFRESH, expiresAt: NOW - 1, account: "person@example.com" };
    const renewed = async (answer: IdentityAnswer | "down"): Promise<{ came: unknown; calls: Call[] }> => {
      const { transport, calls } = stand(answer);
      return { came: await outcome(() => openaiSignIn.refresh(held, transport, NOW, live)), calls };
    };
    const came = async (answers: (IdentityAnswer | "down")[]): Promise<unknown[]> => (await Promise.all(answers.map(renewed))).map((one) => one.came);

    const happy = await renewed(refreshed());
    check("a refresh replaces both tokens and the expiry, and keeps the client and the account", happy.came, { clientId: CLIENT, access: ACCESS_2, refresh: REFRESH_2, expiresAt: NOW + 1_800_000, account: "person@example.com" });
    check("it is one request: the issued client, the held refresh token and the resource, and no scope", happy.calls, [
      { via: "post", url: TOKEN, form: { grant_type: "refresh_token", client_id: CLIENT, refresh_token: REFRESH, resource: RESOURCE } },
    ]);
    check("what was held is not changed by it", held, { clientId: CLIENT, access: ACCESS, refresh: REFRESH, expiresAt: NOW - 1, account: "person@example.com" });
    const quiet = await renewed(refreshed({ scope: undefined, id_token: "an.identity.nobody-checks" }));
    check("an answer naming no scope leaves the grant as it was, and an identity token beside it is not read", [isObject(quiet.came), quiet.calls.length], [true, 1]);

    check("each answer that says the refresh token is no longer one is signed out", await came(SIGNED_OUT.map((error) => ({ status: 400, body: { error } }))), SIGNED_OUT.map(() => "signed_out"));
    check(
      "in either shape and under any status the endpoint gives it",
      await came([
        { status: 401, body: { error: { code: "refresh_token_reused", message: "used" } } },
        { status: 400, body: { code: "refresh_token_expired" } },
        { status: 403, body: { error: "invalid_grant", error_description: REFRESH } },
      ]),
      ["signed_out", "signed_out", "signed_out"],
    );
    check(
      "a refusal that is about something else is not a sign-out: the client, an unknown code, no body",
      await came([{ status: 401, body: { error: "invalid_client" } }, { status: 400, body: { error: "invalid_request" } }, { status: 400, body: null }, { status: 400, body: { error: "invalid grant" } }]),
      ["sign_in_refused", "sign_in_refused", "sign_in_refused", "sign_in_refused"],
    );
    check(
      "and a provider that cannot be asked is neither: what is held stays held",
      await came(["down", { status: 500, body: null }, { status: 502, body: "<html>" }, { status: 503, body: { error: "temporarily_unavailable" } }, { status: 429, body: null }]),
      ["sign_in_unreachable", "sign_in_unreachable", "sign_in_unreachable", "sign_in_unreachable", "sign_in_unreachable"],
    );
    check(
      "a refresh that hands back no replacement token, no access token or no expiry is malformed",
      await came([refreshed({ refresh_token: undefined }), refreshed({ access_token: undefined }), refreshed({ expires_in: undefined }), refreshed({ token_type: undefined }), { status: 200, body: null }]),
      ["sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed", "sign_in_malformed"],
    );
    check("one that comes back without the plan's permission can no longer be spent", await came([refreshed({ scope: "email offline_access openid profile" })]), ["sign_in_not_eligible"]);
  }

  process.stdout.write("\nsign in with ChatGPT: what a refusal says\n");
  {
    const secrets = [CODE, ACCESS, REFRESH, ACCESS_2, REFRESH_2, attempt.verifier, attempt.state, attempt.nonce, good, CLIENT];
    const text = (error: SignInError): string => `${error.message}\n${String(error.cause)}\n${JSON.stringify(error)}`;
    check("the run refused in every way there is", [...new Set(said.map((error) => error.code))].sort(), ["sign_in_malformed", "sign_in_not_eligible", "sign_in_refused", "sign_in_unreachable"]);
    check("no refusal holds a code, a token, a verifier or what a transport threw", said.filter((error) => secrets.some((secret) => text(error).includes(secret)) || error.cause !== undefined).map((error) => error.message), []);
    check("and each is a sentence a person reads", said.filter((error) => !/^[A-Z].*\.$/.test(error.message)).map((error) => error.message), []);
  }

  process.stdout.write("\na ChatGPT plan's requests: what is sent as it came\n");
  const fn = { type: "function", name: "read", parameters: { type: "object", properties: {} }, strict: false };
  const conforming: Json = {
    model: "gpt-6.1-sol",
    instructions: "Be brief.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "one" }] },
      { role: "user", content: "two" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "blob" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "three" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "four", annotations: [] }] },
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "late", parameters: { type: "object", properties: {} } }] },
    ],
    tools: [fn, { type: "custom", name: "patch" }, { type: "namespace", name: "files", description: "File tools.", tools: [fn] }, { type: "web_search" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { format: { type: "text" } },
    prompt_cache_key: "k",
    service_tier: "auto",
    store: false,
    stream: true,
  };
  const kept = canon(conforming);
  {
    check("a request that already conforms passes as it is", shaped(conforming), kept);
    check("with no tools and no instructions too", shaped({ model: "m", input: [], store: false, stream: true }), { input: [], model: "m", store: false, stream: true });
    check("an option this does not know is left where it was", shaped({ ...conforming, some_new_option: { a: 1 } }), canon({ ...conforming, some_new_option: { a: 1 } }));
    const choices = ["none", "required", { type: "function", name: "read" }, { type: "custom", name: "patch" }, { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] }];
    check("as is every way of choosing among tools it may be given", choices.map((tool_choice) => shaped({ ...conforming, tool_choice })), choices.map((tool_choice) => canon({ ...conforming, tool_choice })));
    const before = JSON.stringify({ ...conforming, store: true, temperature: 1, tools: [fn, { type: "mcp", server_label: "s" }], input: [{ role: "system", content: "s" }] });
    const handed = JSON.parse(before) as Json;
    const once = shapeForChatgptPlan(handed);
    check("the request handed in is not written to", JSON.stringify(handed), before);
    check("and shaping what was shaped changes nothing", "body" in once ? shaped(once.body) : null, shaped(handed));
  }

  process.stdout.write("\na ChatGPT plan's requests: what is forced, and what is left behind\n");
  {
    check("it is never stored: true, null and nothing all become false", [true, null, undefined].map((store) => shaped({ ...conforming, store })), [kept, kept, kept]);
    check("and always streamed", [false, null, undefined].map((stream) => shaped({ ...conforming, stream })), [kept, kept, kept]);
    const values: Json = { background: true, metadata: { a: "b" }, moderation: { mode: "x" }, multi_agent: { enabled: true }, prompt_cache_retention: "24h", safety_identifier: "s", truncation: "auto", user: "u" };
    check("each field the route rejects is dropped, and nothing else with it", DROPPED.filter((field) => JSON.stringify(shaped({ ...conforming, [field]: values[field] ?? 1 })) !== JSON.stringify(kept)), []);
    check("all of them at once, false and zero included", shaped({ ...conforming, ...Object.fromEntries(DROPPED.map((field) => [field, field === "background" ? false : 0])) }), kept);
    check("a null where stored state would be named is dropped the same way", shaped({ ...conforming, ...Object.fromEntries(KEPT_AT_VENDOR.map((field) => [field, null])) }), kept);
    const continued: Json = { previous_response_id: "resp_1", conversation: { id: "conv_1" }, prompt: { id: "pmpt_1", variables: {} } };
    check(
      "but a request that continues from what OpenAI keeps is refused by name, never sent short",
      KEPT_AT_VENDOR.map((field) => refusedFor({ ...conforming, [field]: continued[field] }).includes(`(${field})`)),
      [true, true, true],
    );
    check("a conversation named by its id alone is one too", refusedFor({ ...conforming, conversation: "conv_1" }) !== "", true);
  }

  process.stdout.write("\na ChatGPT plan's requests: the conversation\n");
  {
    check("input written as one string is a user message in a list", shaped({ ...conforming, input: "hello" }), canon({ ...conforming, input: [{ role: "user", content: "hello" }] }));
    check("a request with no input at all is refused", [undefined, null, { role: "user" }, 7].map((input) => refusedFor({ ...conforming, input }) !== ""), [true, true, true, true]);
    const spoken = [{ type: "input_text", text: "a" }];
    check(
      "a system message is a developer message, where it stood and with what it said",
      shaped({
        ...conforming,
        input: [
          { type: "message", role: "system", content: spoken },
          { role: "user", content: "b" },
          { role: "system", content: "c" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "d", annotations: [] }], phase: "final_answer" },
          { type: "message", role: "system", content: spoken, status: "completed", id: "msg_1" },
        ],
      }),
      canon({
        ...conforming,
        input: [
          { type: "message", role: "developer", content: spoken },
          { role: "user", content: "b" },
          { role: "developer", content: "c" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "d", annotations: [] }], phase: "final_answer" },
          { type: "message", role: "developer", content: spoken, status: "completed", id: "msg_1" },
        ],
      }),
    );
    const others = [{ type: "function_call_output", call_id: "call_1", output: "role: system" }, { type: "additional_tools", role: "system", tools: [] }, "system", null, ["system"]];
    check("only a message is one: an item of another type is left as it came", shaped({ ...conforming, input: others }), canon({ ...conforming, input: others }));
    check("and instructions are the request's own, whatever the messages were", (shapeForChatgptPlan({ ...conforming, input: [{ role: "system", content: "x" }] }) as { body: Json }).body["instructions"], "Be brief.");
  }

  process.stdout.write("\na ChatGPT plan's requests: tools the vendor runs\n");
  {
    const offered = (type: string): Json => ({ type, ...(type === "mcp" ? { server_label: "s", server_url: "https://example.com/mcp" } : {}) });
    check("each hosted tool merely offered is dropped from the list, and the rest keep their order", HOSTED.filter((type) => JSON.stringify(shaped({ ...conforming, tools: [fn, offered(type), { type: "web_search" }] })) !== JSON.stringify(canon({ ...conforming, tools: [fn, { type: "web_search" }] }))), []);
    check("all of them at once", shaped({ ...conforming, tools: [...HOSTED.map(offered), ...(conforming["tools"] as Json[])] }), kept);
    check("a request offered nothing else is left with no tools", shaped({ ...conforming, tools: HOSTED.map(offered) }), canon(without(conforming, "tools")));
    const local = ["function", "custom", "namespace", "web_search", "shell", "local_shell", "apply_patch", "something_new"].map((type) => ({ type, name: "t" }));
    check("a tool that is not one of those is not this function's to judge", shaped({ ...conforming, tools: local }), canon({ ...conforming, tools: local }));
    check(
      "a request that requires a hosted tool is refused by its name",
      HOSTED.filter((type) => !refusedFor({ ...conforming, tools: [fn, offered(type)], tool_choice: { type } }).includes(`"${type}"`)),
      [],
    );
    check("so is one that must call a tool and was offered only hosted ones", refusedFor({ ...conforming, tools: HOSTED.map(offered), tool_choice: "required" }) !== "", true);
    check(
      "but not one that must call a tool and still has one",
      shaped({ ...conforming, tools: [offered("file_search"), fn], tool_choice: "required" }),
      canon({ ...conforming, tools: [fn], tool_choice: "required" }),
    );
    const allowed = (mode: string, tools: Json[]): Json => ({ type: "allowed_tools", mode, tools });
    const named = { type: "function", name: "read" };
    check(
      "a list of allowed tools loses its hosted entries",
      shaped({ ...conforming, tool_choice: allowed("required", [{ type: "image_generation" }, named, { type: "mcp", server_label: "s" }]) }),
      canon({ ...conforming, tool_choice: allowed("required", [named]) }),
    );
    check("one that requires a call and allows only hosted tools is refused", refusedFor({ ...conforming, tool_choice: allowed("required", [{ type: "image_generation" }]) }) !== "", true);
    check("and one that merely allowed them allows none", shaped({ ...conforming, tool_choice: allowed("auto", [{ type: "image_generation" }, { type: "tool_search" }]) }), canon({ ...conforming, tool_choice: "none" }));
    check("a request that is no object is refused", [null, "x", [], 7].map((body) => refusedFor(body) !== ""), [true, true, true, true]);
    const sentences = [refusedFor(null), refusedFor({ ...conforming, input: undefined }), refusedFor({ ...conforming, prompt: { id: "p" } }), refusedFor({ ...conforming, tool_choice: { type: "mcp" } })];
    check("every refusal is a sentence, and each says a different thing", [sentences.every((sentence) => /^[A-Z].*\.$/.test(sentence)), new Set(sentences).size], [true, 4]);
  }
}
