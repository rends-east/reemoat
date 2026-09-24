import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

// Token wire format only: answers whether a key signed these bytes and decides no policy (auth.ts does).

/** The only accepted alg, compared as an exact string so `none` or an HMAC can never be admitted. */
export const TOKEN_ALG = "EdDSA";

/** Distinguishes our tokens from any other JWT that might be pointed at us. */
export const TOKEN_TYP = "reemoat+jwt";

export interface TokenHeader {
  alg: string;
  typ: string;
  kid: string;
}

/** Times are seconds since the epoch; callers convert from milliseconds at this boundary. */
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
  /** RFC 7800 thumbprint of the key the holder must prove on the handshake; optional because older control planes omit it. */
  cnf?: { jkt: string };
  /** Advisory device id for refusal messages; never branch on it, `cnf` is the binding. */
  dev?: string;
}

export type DecodeFailure =
  | "malformed_token"
  | "bad_header"
  | "bad_alg"
  | "bad_payload";

export type DecodedToken =
  | { ok: true; header: TokenHeader; signingInput: Buffer; signature: Buffer; payloadJson: string }
  | { ok: false; code: DecodeFailure; message: string };

function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Node's base64url decoder skips invalid characters, so re-encode and compare to reject non-canonical input.
function b64uDecode(input: string): Buffer | null {
  if (input.length === 0) return null;
  const decoded = Buffer.from(input, "base64url");
  if (decoded.toString("base64url") !== input) return null;
  return decoded;
}

/** Structural checks only, no signature check: the payload stays an unparsed string until verified. */
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
    // The signature covers the original encoded segments, never a re-encoding of the parsed values.
    signingInput: Buffer.from(`${rawHeader}.${rawPayload}`, "ascii"),
    signature,
    payloadJson: payloadBytes.toString("utf8"),
  };
}

export function verifySignature(decoded: Extract<DecodedToken, { ok: true }>, key: KeyObject): boolean {
  try {
    return verify(null, decoded.signingInput, key, decoded.signature);
  } catch {
    // A key of the wrong type throws rather than returning false.
    return false;
  }
}

/** Call only after verifySignature; every claim must be present and well-typed, so a missing exp is a refusal. */
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

  // A present but malformed cnf is a refusal, never an absence, or a claim edit would downgrade the binding.
  const cnf = fields["cnf"];
  let confirmation: { jkt: string } | undefined;
  if (cnf !== undefined) {
    if (typeof cnf !== "object" || cnf === null || Array.isArray(cnf)) return null;
    const jkt = (cnf as Record<string, unknown>)["jkt"];
    if (typeof jkt !== "string" || jkt.length === 0) return null;
    confirmation = { jkt };
  }

  const dev = fields["dev"];
  if (dev !== undefined && (typeof dev !== "string" || dev.length === 0)) return null;

  return {
    iss,
    sub,
    aud,
    jti,
    iat,
    nbf,
    exp,
    scp: scp as string[],
    ...(confirmation === undefined ? {} : { cnf: confirmation }),
    ...(dev === undefined ? {} : { dev: dev as string }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function signToken(claims: TokenClaims, kid: string, privateKey: KeyObject): string {
  const header: TokenHeader = { alg: TOKEN_ALG, typ: TOKEN_TYP, kid };
  const signingInput = `${b64uEncode(JSON.stringify(header))}.${b64uEncode(JSON.stringify(claims))}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), privateKey);
  return `${signingInput}.${b64uEncode(signature)}`;
}

export interface PublicKeyJwk {
  kty: string;
  crv: string;
  x: string;
}

export function publicKeyToJwk(key: KeyObject): PublicKeyJwk {
  const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
  return { kty: String(jwk["kty"]), crv: String(jwk["crv"]), x: String(jwk["x"]) };
}

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

// Here because the control plane may import only a few root files; one thumbprint implementation serves both sides.

export interface X25519PublicJwk {
  kty: "OKP";
  crv: "X25519";
  x: string;
}

export function x25519Jwk(raw: Uint8Array): X25519PublicJwk {
  return { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") };
}

/** Null unless an X25519 JWK of exactly 32 bytes; nothing downstream would refuse a short key. */
export function x25519FromJwk(jwk: unknown): Buffer | null {
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) return null;
  const fields = jwk as Record<string, unknown>;
  if (fields["kty"] !== "OKP" || fields["crv"] !== "X25519") return null;
  const x = fields["x"];
  if (typeof x !== "string" || x.length === 0) return null;
  const raw = b64uDecode(x);
  if (raw === null || raw.length !== X25519_PUBLIC_BYTES) return null;
  return raw;
}

export const X25519_PUBLIC_BYTES = 32;

/** Full RFC 7638 thumbprint, never truncated since it is a commitment; members in the fixed order crv, kty, x. */
export function jwkThumbprint(jwk: X25519PublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

export function looksLikeSignedToken(token: string): boolean {
  return token.split(".").length === 3;
}
