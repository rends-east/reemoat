#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ALL_SCOPES,
  AUTH_LEEWAY_MS,
  CompositeVerifier,
  SharedSecretVerifier,
  SignedTokenVerifier,
  enrollmentIgnored,
} from "../src/auth.js";
import { codeFingerprint, enroll, EnrollError, parseEnrollResponse } from "../src/enroll.js";
import { publicKeyToJwk, signToken, type TokenClaims } from "../src/token.js";

/**
 * The regression driver for token verification.
 *
 * `harness.ts` is the regression test for the session paths; this is the same
 * idea for the auth paths, and it exists for the same reason: there is no test
 * framework here, so "testable" has to mean "drivable from `scripts/`".
 *
 * Everything below is offline and deterministic — keys are generated in
 * process, `now` is passed in rather than read from the clock. That matters
 * most for the expiry and skew cases, which are otherwise only reachable by
 * waiting five minutes or changing the system time.
 *
 * Run it after touching `src/token.ts`, `src/auth.ts` or `src/enroll.ts`:
 *   pnpm authcheck
 */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function codeOf(result: { ok: boolean; code?: string }): string {
  return result.ok ? "(accepted)" : (result.code ?? "?");
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const kid = "k_authcheck";
const identity = {
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }],
};

// A fixed instant, so every boundary below is exact rather than approximate.
const now = 1_800_000_000_000;
const iat = Math.floor(now / 1000);
const claims: TokenClaims = {
  iss: "reemoat-cp",
  sub: "u_alice",
  aud: "m_self",
  jti: "t_1",
  iat,
  nbf: iat,
  exp: iat + 300,
  scp: ["session:read", "session:write", "not:a:real:scope"],
};

const skews: string[] = [];
const signed = new SignedTokenVerifier({ identity, onSuspectedClockSkew: (detail) => skews.push(detail) });
const good = signToken(claims, kid, privateKey);

process.stdout.write("\nsigned tokens\n");
const accepted = signed.verify(good, now);
check("a well-formed token is accepted", accepted.ok, true);
if (accepted.ok) {
  check("subject is carried through", accepted.principal.subject, "u_alice");
  check("unknown scopes are dropped, not fatal", accepted.principal.scopes, ["session:read", "session:write"]);
  check("expiry is exposed in ms", accepted.principal.expiresAt, (iat + 300) * 1000);
  check("jti is carried through", accepted.principal.tokenId, "t_1");
}

process.stdout.write("\nforgery\n");
// The one that turns a single grant into a grant on the whole fleet.
check(
  "a token for another machine is refused",
  codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now)),
  "wrong_machine",
);
check(
  "a token from another issuer is refused",
  codeOf(signed.verify(signToken({ ...claims, iss: "somebody-else" }, kid, privateKey), now)),
  "wrong_issuer",
);
check(
  "a token signed by another key is refused",
  codeOf(signed.verify(signToken(claims, kid, attacker.privateKey), now)),
  "bad_signature",
);
check(
  "a token naming an unknown key is refused",
  codeOf(signed.verify(signToken(claims, "k_unknown", privateKey), now)),
  "unknown_key",
);

// alg confusion, in both of its usual shapes.
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const payload = b64(claims);
check(
  'alg:"none" is refused',
  codeOf(signed.verify(`${b64({ alg: "none", typ: "reemoat+jwt", kid })}.${payload}.`, now)),
  "malformed_token",
);
check(
  "an HMAC alg is refused",
  codeOf(signed.verify(`${b64({ alg: "HS256", typ: "reemoat+jwt", kid })}.${payload}.AAAA`, now)),
  "malformed_token",
);
check(
  "a foreign typ is refused",
  codeOf(signed.verify(`${b64({ alg: "EdDSA", typ: "JWT", kid })}.${payload}.AAAA`, now)),
  "malformed_token",
);
// Non-canonical base64url would otherwise make one token into a family of them,
// all verifying against one signature, which would make jti meaningless.
check(
  "padded base64url is refused",
  codeOf(signed.verify(`${b64({ alg: "EdDSA", typ: "reemoat+jwt", kid })}==.${payload}.AA`, now)),
  "malformed_token",
);
/*
 * The other two segments, and the character that actually motivated the check.
 *
 * `Buffer.from(s, "base64url")` silently skips what it does not recognise, so
 * `"ab!cd"` and `"abcd"` decode identically. Padding on the header covered only
 * one third of the surface; without the re-encode comparison in `b64uDecode` the
 * *payload* variant verifies against the real signature, which is the case that
 * turns one token into a family of them and makes `jti` stop identifying one.
 */
const [goodHeader, goodPayload, goodSignature] = good.split(".") as [string, string, string];
check(
  "a non-canonical payload is refused",
  codeOf(signed.verify(`${goodHeader}.${goodPayload}!.${goodSignature}`, now)),
  "malformed_token",
);
check(
  "a non-canonical signature is refused",
  codeOf(signed.verify(`${goodHeader}.${goodPayload}.${goodSignature}!`, now)),
  "malformed_token",
);

process.stdout.write("\nthe clock\n");
const expMs = (iat + 300) * 1000;
const nbfMs = iat * 1000;
check("accepted exactly at the far edge of leeway", signed.verify(good, expMs + AUTH_LEEWAY_MS).ok, true);
check("refused one ms past it", codeOf(signed.verify(good, expMs + AUTH_LEEWAY_MS + 1)), "token_expired");
check("accepted exactly at the near edge of leeway", signed.verify(good, nbfMs - AUTH_LEEWAY_MS).ok, true);
check("refused one ms before it", codeOf(signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 1)), "token_not_yet_valid");

skews.length = 0;
const late = signed.verify(good, expMs + AUTH_LEEWAY_MS + 30_000);
check("a near miss reports suspected skew", skews.length, 1);
// The number itself, not just that something was reported: a client that cannot
// see how far outside the window it fell cannot tell a wrong clock from a token
// that simply died, which is the entire purpose of returning it.
check("and says how far outside the window it fell", late.ok ? null : late.skewMs, 30_000);
skews.length = 0;
signed.verify(good, expMs + AUTH_LEEWAY_MS + 3_600_000);
check("a wild miss does not", skews.length, 0);

/*
 * The same pair on the `nbf` side.
 *
 * "Clock skew is reported in both directions, deliberately" was only half driven:
 * both existing cases sit past `exp`, so the `token_not_yet_valid` branch — the
 * one a phone with a *fast* clock hits — never reported anything here.
 */
skews.length = 0;
const early = signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 30_000);
check("a near miss the other way reports skew too", skews.length, 1);
check("and says how far the other way", early.ok ? null : early.skewMs, 30_000);
skews.length = 0;
signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 3_600_000);
check("a wild miss the other way does not", skews.length, 0);

process.stdout.write("\nthe shared secret\n");
const shared = new SharedSecretVerifier("hunter2");
check("the right secret is accepted", shared.verify("hunter2").ok, true);
check("a wrong secret is refused", codeOf(shared.verify("hunter3")), "bad_credential");
check("an empty credential is refused", codeOf(shared.verify("")), "missing_token");
const sharedOk = shared.verify("hunter2");
check("it grants every scope", sharedOk.ok ? [...sharedOk.principal.scopes] : null, [...ALL_SCOPES]);
check("it never expires", sharedOk.ok ? sharedOk.principal.expiresAt : "?", null);

process.stdout.write("\nboth modes at once\n");
const both = new CompositeVerifier(signed, shared);
check("a secret still works", both.verify("hunter2", now).ok, true);
check("a signed token still works", both.verify(good, now).ok, true);
// Routed by shape, so a signed token that fails for a real reason reports that
// reason rather than being retried as a secret and coming back as garbage.
check(
  "a bad signed token keeps its own failure",
  codeOf(both.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now)),
  "wrong_machine",
);

process.stdout.write("\nthe enrollment response\n");
const enrolled = parseEnrollResponse({
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }, { kid: "k_junk", jwk: { kty: "oct", k: "nope" } }],
});
check("usable keys survive", enrolled.keys.length, 1);
check("an unusable key is dropped, not fatal", enrolled.keys[0]?.kid, kid);
for (const [name, body] of [
  ["no machineId", { issuer: "x", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }],
  ["no issuer", { machineId: "m", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }],
  ["no keys at all", { machineId: "m", issuer: "x", keys: [] }],
  ["only unusable keys", { machineId: "m", issuer: "x", keys: [{ kid: "k", jwk: { kty: "oct" } }] }],
] as const) {
  let threw = false;
  try {
    parseEnrollResponse(body);
  } catch {
    threw = true;
  }
  check(`an enrollment response with ${name} is refused`, threw, true);
}

/* ------------------------------------------------------------------ *
 * The one request this daemon ever makes
 *
 * Loopback only, so this stays offline and deterministic. What is being pinned is
 * the shape of `enroll`'s failure handling, which the parser cases above cannot
 * reach at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe enrollment request\n");
{
  /*
   * Headers, then silence.
   *
   * `fetch` resolves as soon as the *headers* arrive, so a control plane that
   * answers 200 and then stalls the body would hang startup for ever if the
   * timeout were cleared at that point. `enroll` therefore clears its timer after
   * reading the body, and this is the case that says so.
   */
  const stalling = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", () => resolve()));
  const stallPort = (stalling.address() as AddressInfo).port;

  let code = "(no error)";
  try {
    await enroll({ controlPlane: `http://127.0.0.1:${stallPort}`, code: "ec_test", timeoutMs: 250 });
  } catch (error) {
    code = error instanceof EnrollError ? error.code : "(not an EnrollError)";
  }
  check("a control plane that answers and then stalls is a timeout", code, "timeout");
  stalling.close();

  // A refusal is a refusal, not a retry-forever. Codes are single use, so the
  // second boot with a spent code has to fail loudly rather than quietly.
  const refusing = createServer((_req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "code_spent", message: "already used" } }));
  });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", () => resolve()));
  const refusePort = (refusing.address() as AddressInfo).port;
  let refusedCode = "(no error)";
  try {
    await enroll({ controlPlane: `http://127.0.0.1:${refusePort}`, code: "ec_spent", timeoutMs: 2_000 });
  } catch (error) {
    refusedCode = error instanceof EnrollError ? error.code : "(not an EnrollError)";
  }
  check("a refused code is reported as such", refusedCode, "code_rejected");
  refusing.close();

  /*
   * The fingerprint, which is the whole of "a restart with the same enrollment
   * code makes no network call". Codes are single use, so a daemon that
   * re-exchanged on every boot would fail to start the second time — and the
   * comparison has to survive the trimming both `enroll` and the daemon do.
   */
  check("the same code fingerprints the same across a restart", codeFingerprint(" ec_test\n"), codeFingerprint("ec_test"));
  check(
    "a different code does not",
    codeFingerprint("ec_test") === codeFingerprint("ec_other"),
    false,
  );
}

process.stdout.write("\na daemon that enrolled and is about to ignore it\n");
{
  /*
   * The missing half of a check `daemon.ts` already makes.
   *
   * It refuses to start for the opposite mismatch — `REEMOAT_AUTH=signed` with
   * no stored identity exits 2 — and said nothing about a stored identity with no
   * `REEMOAT_AUTH`. Measured 2026-08-01 on a machine enrolled as `m_ffeaf8c7`:
   * restarting it without the variable (which lived in a shell rather than in
   * `.env`) brought it up as `shared_secret`, and **both** routes to it vanished
   * at once — a browser holds a control-plane token, which that mode does not
   * verify, and the relay tunnel is never dialled either. `/health` answered 200
   * throughout, so the daemon looked healthy while being unreachable.
   */
  const enrolled = { machineId: "m_ffeaf8c7" };
  const warning = enrollmentIgnored(undefined, enrolled);
  check("an enrolled daemon with no REEMOAT_AUTH is warned about", warning !== null, true);
  // Naming the machine is what makes the line actionable rather than a lecture:
  // it is the fact that proves the daemon *did* enroll, which is the thing an
  // operator reading `auth: shared_secret` cannot otherwise see.
  check("and the warning names the machine it enrolled as", (warning ?? "").includes("m_ffeaf8c7"), true);
  check("and says what is lost, not just what is set", (warning ?? "").includes("relay"), true);

  /*
   * Unset and explicitly `shared_secret` are different things, and that is the
   * whole discrimination.
   *
   * Unset means nobody decided and the default answered for them. An explicit
   * value means somebody did — and `.env.example` is clear that dropping an
   * enrolled daemon to the shared secret is a supported break-glass move, because
   * enrolling a machine you reach over the network is exactly when you can lock
   * yourself out of it. Warning there would be shouting at the one operator who
   * most needs the path to stay quiet and available.
   */
  check("an explicit shared_secret is a decision, not a mistake", enrollmentIgnored("shared_secret", enrolled), null);
  check("so is an explicit signed", enrollmentIgnored("signed", enrolled), null);
  check("and an explicit both", enrollmentIgnored("both", enrolled), null);
  // Empty counts as unset, because `resolveAuthMode` already treats it that way —
  // `REEMOAT_AUTH=` in a file is not a decision either.
  check("an empty value is unset, not a decision", enrollmentIgnored("   ", enrolled) !== null, true);

  /*
   * The common case stays silent. A daemon that never enrolled is the
   * single-machine shape `shared_secret` exists for, and the opposite direction
   * is already an exit-2 in `daemon.ts` rather than anything this reports.
   */
  check("a daemon that never enrolled is not warned at", enrollmentIgnored(undefined, null), null);
  check("nor is one that never enrolled and asked for signed", enrollmentIgnored("signed", null), null);
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
