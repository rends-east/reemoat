#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ALL_SCOPES,
  AUTH_LEEWAY_MS,
  CompositeVerifier,
  NO_CHANNEL,
  SharedSecretVerifier,
  SignedTokenVerifier,
  enrollmentIgnored,
  type ChannelIdentity,
} from "../src/auth.js";
import { generateStaticKey } from "@reemoat/protocol";
import { codeFingerprint, enroll, EnrollError, parseEnrollResponse } from "../src/enroll.js";
import { jwkThumbprint, publicKeyToJwk, signToken, x25519Jwk, type TokenClaims } from "../src/token.js";

// Offline driver for token verification and enrollment: keys are generated in process and `now` is passed in.

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
const aliceDevice = generateStaticKey();
const malloryDevice = generateStaticKey();
const aliceThumbprint = jwkThumbprint(x25519Jwk(aliceDevice.publicKey));
const malloryThumbprint = jwkThumbprint(x25519Jwk(malloryDevice.publicKey));
const aliceChannel: ChannelIdentity = { peerKeyThumbprint: aliceThumbprint };

const claims: TokenClaims = {
  iss: "reemoat-cp",
  sub: "u_alice",
  aud: "m_self",
  jti: "t_1",
  iat,
  nbf: iat,
  exp: iat + 300,
  scp: ["session:read", "session:write", "not:a:real:scope"],
  cnf: { jkt: aliceThumbprint },
  dev: "dv_alice",
};

const skews: string[] = [];
const signed = new SignedTokenVerifier({ identity, onSuspectedClockSkew: (detail) => skews.push(detail) });
const good = signToken(claims, kid, privateKey);

process.stdout.write("\nsigned tokens\n");
const accepted = signed.verify(good, now, aliceChannel);
check("a well-formed token is accepted", accepted.ok, true);
if (accepted.ok) {
  check("subject is carried through", accepted.principal.subject, "u_alice");
  check("unknown scopes are dropped, not fatal", accepted.principal.scopes, ["session:read", "session:write"]);
  check("expiry is exposed in ms", accepted.principal.expiresAt, (iat + 300) * 1000);
  check("jti is carried through", accepted.principal.tokenId, "t_1");
}

process.stdout.write("\nforgery\n");
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
// Non-canonical base64url would make one token a family sharing one signature, and jti meaningless.
check(
  "padded base64url is refused",
  codeOf(signed.verify(`${b64({ alg: "EdDSA", typ: "reemoat+jwt", kid })}==.${payload}.AA`, now)),
  "malformed_token",
);
// Buffer.from with base64url skips unknown characters, so without the re-encode check in b64uDecode the payload variant verifies.
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
check("accepted exactly at the far edge of leeway", signed.verify(good, expMs + AUTH_LEEWAY_MS, aliceChannel).ok, true);
check("refused one ms past it", codeOf(signed.verify(good, expMs + AUTH_LEEWAY_MS + 1, aliceChannel)), "token_expired");
check("accepted exactly at the near edge of leeway", signed.verify(good, nbfMs - AUTH_LEEWAY_MS, aliceChannel).ok, true);
check("refused one ms before it", codeOf(signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 1, aliceChannel)), "token_not_yet_valid");

skews.length = 0;
const late = signed.verify(good, expMs + AUTH_LEEWAY_MS + 30_000, aliceChannel);
check("a near miss reports suspected skew", skews.length, 1);
check("and says how far outside the window it fell", late.ok ? null : late.skewMs, 30_000);
skews.length = 0;
signed.verify(good, expMs + AUTH_LEEWAY_MS + 3_600_000, aliceChannel);
check("a wild miss does not", skews.length, 0);

skews.length = 0;
const early = signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 30_000, aliceChannel);
check("a near miss the other way reports skew too", skews.length, 1);
check("and says how far the other way", early.ok ? null : early.skewMs, 30_000);
skews.length = 0;
signed.verify(good, nbfMs - AUTH_LEEWAY_MS - 3_600_000, aliceChannel);
check("a wild miss the other way does not", skews.length, 0);

process.stdout.write("\nthe shared secret\n");
const shared = new SharedSecretVerifier("hunter2");
check("the right secret is accepted", shared.verify("hunter2").ok, true);
check("a wrong secret is refused", codeOf(shared.verify("hunter3")), "bad_credential");
check("an empty credential is refused", codeOf(shared.verify("")), "missing_token");
const sharedOk = shared.verify("hunter2");
check("it grants every scope", sharedOk.ok ? [...sharedOk.principal.scopes] : null, [...ALL_SCOPES]);
check("it never expires", sharedOk.ok ? sharedOk.principal.expiresAt : "?", null);

// A capability names the device key the encrypted channel must have authenticated: authentication, not authorization.

process.stdout.write("\nthe device a capability was minted for\n");
{
  check("a capability presented by the device it names is accepted", signed.verify(good, now, aliceChannel).ok, true);
  if (signed.verify(good, now, aliceChannel).ok) {
    const principal = signed.verify(good, now, aliceChannel);
    check(
      "and the installation is carried through for the audit trail",
      principal.ok ? principal.principal.deviceId : "?",
      "dv_alice",
    );
  }

  check(
    "the same capability from another device is refused",
    codeOf(signed.verify(good, now, { peerKeyThumbprint: malloryThumbprint })),
    "wrong_device",
  );
  // No cnf is what an older control plane mints: its own code because the remedy is the operator's, and never accepted.
  const { cnf: _dropped, ...unbound } = claims;
  check(
    "a capability naming no device is refused over a channel that names one",
    codeOf(signed.verify(signToken(unbound, kid, privateKey), now, aliceChannel)),
    "unbound_capability",
  );
  const malformed = { ...claims, cnf: { jkt: "" } } as unknown as TokenClaims;
  check(
    "a confirmation claim that is present and malformed is malformed, not absent",
    codeOf(signed.verify(signToken(malformed, kid, privateKey), now, aliceChannel)),
    "malformed_token",
  );

  check(
    "a capability for another machine reports the machine, not the device",
    codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now, NO_CHANNEL)),
    "wrong_machine",
  );
  check(
    "an expired capability from the wrong device reports the device",
    codeOf(signed.verify(good, expMs + AUTH_LEEWAY_MS + 1, { peerKeyThumbprint: malloryThumbprint })),
    "wrong_device",
  );
  // No channel and no cnf must stay accepted: that is the desktop app on loopback, reached through the NO_CHANNEL default.
  check("loopback accepts a capability with no channel to bind to", signed.verify(good, now, NO_CHANNEL).ok, true);
  check(
    "and one that names no device at all",
    signed.verify(signToken(unbound, kid, privateKey), now, NO_CHANNEL).ok,
    true,
  );
  check(
    "but it is still the same machine check",
    codeOf(signed.verify(signToken({ ...claims, aud: "m_other" }, kid, privateKey), now, NO_CHANNEL)),
    "wrong_machine",
  );
  // The auth gate calls verify with no channel argument, so the parameter default is driven too.
  check(
    "and the default channel answers exactly as naming it does",
    codeOf(signed.verify(signToken(unbound, kid, privateKey), now)),
    "(accepted)",
  );
}

process.stdout.write("\nboth modes at once\n");
const both = new CompositeVerifier(signed, shared);
check("a secret still works", both.verify("hunter2", now).ok, true);
check("a signed token still works", both.verify(good, now, aliceChannel).ok, true);
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

process.stdout.write("\nthe enrollment request\n");
{
  // fetch resolves at the headers, so enroll must clear its timer only after reading the body.
  const stalling = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
  });
  await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", () => resolve()));
  const stallPort = (stalling.address() as AddressInfo).port;

  // Raced against a watchdog because the regression hangs rather than fails; then(onOk, onErr) keeps the losing rejection handled.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([
    enroll({ controlPlane: `http://127.0.0.1:${stallPort}`, code: "ec_test", timeoutMs: 250 }).then(
      () => "(no error)",
      (error: unknown) => (error instanceof EnrollError ? error.code : "(not an EnrollError)"),
    ),
    new Promise<string>((resolve) => {
      watchdog = setTimeout(() => resolve("(never settled)"), 10_000);
    }),
  ]);
  clearTimeout(watchdog);
  check("a control plane that answers and then stalls is a timeout", code, "timeout");
  stalling.close();

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

  // Method, path and content type are kept beside the body: a wrong path surfaces from enroll only as code_rejected.
  interface Recorded {
    method: string;
    path: string;
    contentType: string;
    body: string;
  }
  const posted: Recorded[] = [];
  const recording = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      posted.push({
        method: req.method ?? "(none)",
        path: req.url ?? "(none)",
        contentType: req.headers["content-type"] ?? "(none)",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ machineId: "m_self", issuer: "reemoat-cp", keys: [{ kid, jwk: publicKeyToJwk(publicKey) }] }));
    });
  });
  await new Promise<void>((resolve) => recording.listen(0, "127.0.0.1", () => resolve()));
  const recordPort = (recording.address() as AddressInfo).port;

  const announced = Buffer.from(generateStaticKey().publicKey).toString("base64url");

  const bodyOf = (index: number): Record<string, unknown> => {
    const raw = posted[index]?.body;
    // An object either way, so a missing request fails an assertion by name instead of throwing.
    if (raw === undefined) return { "(no request arrived)": index };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { "(not an object)": raw };
      return parsed as Record<string, unknown>;
    } catch {
      return { "(unparseable)": raw };
    }
  };

  const exchangeErrors: string[] = [];
  const post = async (options: { code: string; machineKey?: string }): Promise<void> => {
    try {
      await enroll({ controlPlane: `http://127.0.0.1:${recordPort}`, timeoutMs: 2_000, ...options });
    } catch (error) {
      exchangeErrors.push(`${options.code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await post({ code: "ec_announced", machineKey: announced });
  await post({ code: "ec_silent" });
  await post({ code: "ec_blank", machineKey: "  \n\t " });
  await post({ code: " ec_padded \n", machineKey: `  ${announced}\n` });

  // A diagnostic only: an empty list is also what no calls would leave. The count below is the liveness check.
  check("no exchange threw", exchangeErrors, []);
  check("four requests reached the stub", posted.length, 4);

  // Exact arrays of distinct values, so a skipped request cannot hide the way it could behind a floor.
  const distinct = (pick: (entry: Recorded) => string): string[] => [...new Set(posted.map(pick))].sort();
  check("every one of them is a POST", distinct((entry) => entry.method), ["POST"]);
  check("to /v1/enroll and nothing else", distinct((entry) => entry.path), ["/v1/enroll"]);
  check("declaring itself JSON", distinct((entry) => entry.contentType), ["application/json"]);

  const withKey = bodyOf(0);
  check("the code a daemon redeems reaches the wire", withKey["code"], "ec_announced");
  check("and the machine key beside it, unaltered", withKey["machineKey"], announced);
  // The whole body: a third field would be a new dialect to an older control plane.
  check("and those two are the whole body", Object.keys(withKey).sort(), ["code", "machineKey"]);

  // Absent, not null or empty: an older daemon sent exactly { code }. `in`, because a missing body also reads as undefined.
  const silent = bodyOf(1);
  check("a daemon with no key to announce still sends its code", silent["code"], "ec_silent");
  check("and the field is absent rather than null", "machineKey" in silent, false);

  // Without the trim a whitespace-only key goes on the wire, the far side parses it to null, and the re-pin silently does not happen.
  const blank = bodyOf(2);
  check("whitespace is not a key to announce", blank["code"], "ec_blank");
  check("and it is absent too, not empty", "machineKey" in blank, false);

  const padded = bodyOf(3);
  check("a padded code reaches the wire trimmed", padded["code"], "ec_padded");
  check("and so does a padded key", padded["machineKey"], announced);

  recording.close();

  // Codes are single use, so a restart with the same code must be recognised without a network call.
  check("the same code fingerprints the same across a restart", codeFingerprint(" ec_test\n"), codeFingerprint("ec_test"));
  check(
    "a different code does not",
    codeFingerprint("ec_test") === codeFingerprint("ec_other"),
    false,
  );
  // A fingerprint, not the code: daemon.ts persists it as codeFp, and its width is a stored format.
  const fingerprinted = codeFingerprint("ec_test");
  check("a fingerprint does not carry the code it was made from", fingerprinted.includes("ec_test"), false);
  check("and it is a fixed-width hex digest", /^[0-9a-f]{32}$/.test(fingerprinted), true);
}

process.stdout.write("\na daemon that enrolled and is about to ignore it\n");
{
  // The half daemon.ts does not refuse: an enrolled daemon with REEMOAT_AUTH unset comes up shared_secret and is unreachable while /health answers.
  const enrolled = { machineId: "m_ffeaf8c7" };
  const warning = enrollmentIgnored(undefined, enrolled);
  check("an enrolled daemon with no REEMOAT_AUTH is warned about", warning !== null, true);
  check("and the warning names the machine it enrolled as", (warning ?? "").includes("m_ffeaf8c7"), true);
  check("and says what is lost, not just what is set", (warning ?? "").includes("relay"), true);

  // An explicit shared_secret is a supported break-glass move; only unset is warned about.
  check("an explicit shared_secret is a decision, not a mistake", enrollmentIgnored("shared_secret", enrolled), null);
  check("so is an explicit signed", enrollmentIgnored("signed", enrolled), null);
  check("and an explicit both", enrollmentIgnored("both", enrolled), null);
  // Empty counts as unset, as resolveAuthMode already treats it.
  check("an empty value is unset, not a decision", enrollmentIgnored("   ", enrolled) !== null, true);

  check("a daemon that never enrolled is not warned at", enrollmentIgnored(undefined, null), null);
  check("nor is one that never enrolled and asked for signed", enrollmentIgnored("signed", null), null);
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
