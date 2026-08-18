import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * The token wire format, and the only place that encodes or decodes one.
 *
 * A compact JWS — `base64url(header).base64url(payload).base64url(signature)` —
 * signed with Ed25519. Hand-rolled rather than taken from a library because
 * there is no usable one here: `jose` appears in the lockfile, but only as a
 * transitive dependency of `@agentclientprotocol/*`, and pnpm's strict layout
 * makes it unimportable from `src/`. `node:crypto` signs and verifies Ed25519
 * synchronously, which is what this file needs anyway.
 *
 * Both directions live here, in one file, for the same reason `git.ts` owns
 * every git spawn: the rules that make a token safe to trust are auditable in
 * one place rather than split across the signer and the verifier, where they
 * could drift apart and only the drift would be exploitable.
 *
 * This module decides nothing about *policy* — no expiry checks, no audience
 * checks, no scope interpretation. It answers exactly one question: "did the
 * holder of this private key produce these bytes". `auth.ts` decides what that
 * entitles anyone to. Keeping the split means a claim can never be read on a
 * path where the signature has not already been checked.
 */

/**
 * The only algorithm this daemon will ever accept.
 *
 * Checked as an exact string, and then used only to look a key up in a set we
 * already trust and hand it to Ed25519 verification. That is what makes
 * algorithm confusion — `alg: "none"`, or an HMAC whose "verification" key is
 * the attacker-known public key — structurally impossible here rather than
 * something this file defends against case by case.
 */
export const TOKEN_ALG = "EdDSA";

/** Distinguishes our tokens from any other JWT that might be pointed at us. */
export const TOKEN_TYP = "reemoat+jwt";

export interface TokenHeader {
  alg: string;
  typ: string;
  kid: string;
}

/**
 * The claims, in seconds since the epoch — the JWT convention, kept so the
 * tokens read normally in any debugger. Callers work in milliseconds and
 * convert at this boundary; nothing downstream sees seconds.
 */
export interface TokenClaims {
  iss: string;
  sub: string;
  /** The machine id. A token minted for one daemon is useless at another. */
  aud: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  scp: string[];
}

export type DecodeFailure =
  | "malformed_token"
  | "bad_header"
  | "bad_alg"
  | "bad_payload";

export type DecodedToken =
  | { ok: true; header: TokenHeader; signingInput: Buffer; signature: Buffer; payloadJson: string }
  | { ok: false; code: DecodeFailure; message: string };

/* ------------------------------------------------------------------ *
 * base64url
 * ------------------------------------------------------------------ */

function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Strict decode.
 *
 * `Buffer.from(s, "base64url")` is famously lenient: it skips characters it
 * does not recognise instead of failing, so `"ab!cd"` and `"abcd"` decode to
 * the same bytes. Two distinct token strings that decode identically would
 * both verify against one signature, which turns a token into a family of
 * tokens and makes `jti` useless as an identifier. Re-encoding and comparing is
 * the cheapest way to insist the input was already canonical.
 */
function b64uDecode(input: string): Buffer | null {
  if (input.length === 0) return null;
  const decoded = Buffer.from(input, "base64url");
  if (decoded.toString("base64url") !== input) return null;
  return decoded;
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

/**
 * Splits and structurally validates a token without checking the signature.
 *
 * Deliberately returns the payload as an unparsed string. A caller that has not
 * yet verified the signature has no business holding parsed claims, and handing
 * back a `TokenClaims` here would make it easy to write exactly that bug.
 */
export function decodeToken(token: string): DecodedToken {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, code: "malformed_token", message: "token is not a compact JWS" };
  }
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const headerBytes = b64uDecode(rawHeader);
  if (headerBytes === null) {
    return { ok: false, code: "malformed_token", message: "token header is not valid base64url" };
  }

  let header: unknown;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    return { ok: false, code: "bad_header", message: "token header is not valid JSON" };
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return { ok: false, code: "bad_header", message: "token header is not an object" };
  }
  const fields = header as Record<string, unknown>;
  const alg = fields["alg"];
  const typ = fields["typ"];
  const kid = fields["kid"];

  // Before anything else touches this token. `alg: "none"` and every symmetric
  // algorithm die here, on an exact string comparison, with no table lookup
  // that could ever be extended by accident.
  if (alg !== TOKEN_ALG) {
    return { ok: false, code: "bad_alg", message: `unsupported alg; only ${TOKEN_ALG} is accepted` };
  }
  if (typ !== TOKEN_TYP) {
    return { ok: false, code: "bad_header", message: `unsupported typ; expected ${TOKEN_TYP}` };
  }
  if (typeof kid !== "string" || kid.length === 0) {
    return { ok: false, code: "bad_header", message: "token header has no kid" };
  }

  const signature = b64uDecode(rawSignature);
  if (signature === null) {
    return { ok: false, code: "malformed_token", message: "token signature is not valid base64url" };
  }
  const payloadBytes = b64uDecode(rawPayload);
  if (payloadBytes === null) {
    return { ok: false, code: "malformed_token", message: "token payload is not valid base64url" };
  }

  return {
    ok: true,
    header: { alg, typ, kid },
    // The signature covers the *encoded* header and payload, byte for byte, so
    // it is taken from the original string rather than re-encoded from the
    // parsed values. Re-encoding would verify a token we reconstructed rather
    // than the one we were handed.
    signingInput: Buffer.from(`${rawHeader}.${rawPayload}`, "ascii"),
    signature,
    payloadJson: payloadBytes.toString("utf8"),
  };
}

/**
 * Ed25519 verification. `null` as the algorithm is how `node:crypto` says
 * "the key knows"; Ed25519 prescribes its own hash and rejects any other.
 */
export function verifySignature(decoded: Extract<DecodedToken, { ok: true }>, key: KeyObject): boolean {
  try {
    return verify(null, decoded.signingInput, key, decoded.signature);
  } catch {
    // A key of the wrong type reaches here rather than returning false. Both
    // mean the same thing to a caller — this token is not trustworthy.
    return false;
  }
}

/**
 * Parses claims. Only ever called after `verifySignature` has returned true.
 *
 * Every field is checked for presence and type: a token missing `exp` must be
 * rejected, not treated as one that never expires, and that is exactly the
 * shape of bug a permissive parse would introduce.
 */
export function parseClaims(payloadJson: string): TokenClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;

  const iss = fields["iss"];
  const sub = fields["sub"];
  const aud = fields["aud"];
  const jti = fields["jti"];
  const iat = fields["iat"];
  const nbf = fields["nbf"];
  const exp = fields["exp"];
  const scp = fields["scp"];

  if (typeof iss !== "string" || iss.length === 0) return null;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (typeof aud !== "string" || aud.length === 0) return null;
  if (typeof jti !== "string" || jti.length === 0) return null;
  if (!isFiniteNumber(iat) || !isFiniteNumber(nbf) || !isFiniteNumber(exp)) return null;
  if (!Array.isArray(scp) || !scp.every((entry) => typeof entry === "string")) return null;

  return { iss, sub, aud, jti, iat, nbf, exp, scp: scp as string[] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/* ------------------------------------------------------------------ *
 * Signing — used by the control plane, never by the daemon
 * ------------------------------------------------------------------ */

export function signToken(claims: TokenClaims, kid: string, privateKey: KeyObject): string {
  const header: TokenHeader = { alg: TOKEN_ALG, typ: TOKEN_TYP, kid };
  const signingInput = `${b64uEncode(JSON.stringify(header))}.${b64uEncode(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), privateKey);
  return `${signingInput}.${b64uEncode(signature)}`;
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/** An Ed25519 public key as it travels: JWK, so it survives JSON unharmed. */
export interface PublicKeyJwk {
  kty: string;
  crv: string;
  x: string;
}

export function publicKeyToJwk(key: KeyObject): PublicKeyJwk {
  const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
  return { kty: String(jwk["kty"]), crv: String(jwk["crv"]), x: String(jwk["x"]) };
}

/**
 * Rebuilds a public key from a JWK, refusing anything that is not Ed25519.
 *
 * Returns `null` rather than throwing: this parses material that arrived over
 * the network at enrollment, and a caller has to handle bad input anyway.
 */
export function jwkToPublicKey(jwk: unknown): KeyObject | null {
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) return null;
  const fields = jwk as Record<string, unknown>;
  if (fields["kty"] !== "OKP" || fields["crv"] !== "Ed25519") return null;
  if (typeof fields["x"] !== "string" || fields["x"].length === 0) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: fields["x"] }, format: "jwk" });
  } catch {
    // Malformed `x` — the key is unusable and the caller will refuse the token.
    return null;
  }
}

/** A token is recognisable by shape before anything is decoded. */
export function looksLikeSignedToken(token: string): boolean {
  return token.split(".").length === 3;
}
