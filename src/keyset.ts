import {
  KEYSET_TYP,
  ROOT_TYP,
  decodeSigned,
  jwkToPublicKey,
  parseKeysetStatement,
  parseRootEndorsement,
  verifySignature,
  type DecodedToken,
} from "./token.js";

// What a relay announced on a dial, weighed against what this machine already trusts. Pure: no clock, no store, no network.
// Nothing here is asked for: an announcement that is absent or refused changes nothing, and verification goes on with the keys held.

export interface TrustedKey {
  kid: string;
  jwk: unknown;
}

export interface KeysetHeld {
  issuer: string;
  keys: readonly TrustedKey[];
  /** `null` until a held signing key introduces one, or enrollment hands one over. */
  root: TrustedKey | null;
  keysetVersion: number | null;
}

export interface KeysetAnnouncement {
  statement: string | null;
  endorsements: readonly string[];
}

export type StatementRefusal =
  | "absent"
  | "no_root"
  | "unreadable"
  | "wrong_root"
  | "bad_signature"
  | "wrong_issuer"
  | "not_newer"
  | "no_usable_keys";

export interface KeysetOutcome {
  /** What to hold from now on; `held` itself when nothing moved. */
  next: KeysetHeld;
  rootChanged: boolean;
  keysChanged: boolean;
  /** Why the statement was not taken, or `null` when it was. */
  refused: StatementRefusal | null;
}

/** How many roots back a daemon may be and still follow the handovers to the live one. */
export const MAX_ROOT_HANDOVERS = 4;

export const MAX_ANNOUNCED_ENDORSEMENTS = 16;

interface Endorsement {
  signer: string;
  decoded: Extract<DecodedToken, { ok: true }>;
}

export function weighAnnouncement(held: KeysetHeld, announced: KeysetAnnouncement): KeysetOutcome {
  const endorsements: Endorsement[] = [];
  for (const text of announced.endorsements.slice(0, MAX_ANNOUNCED_ENDORSEMENTS)) {
    const decoded = decodeSigned(text, ROOT_TYP);
    if (decoded.ok) endorsements.push({ signer: decoded.header.kid, decoded });
  }

  let root = held.root;
  // Only a signing key already held may introduce a root, and only where none is held: a held root is replaced by its own signature alone.
  if (root === null) {
    for (const endorsement of endorsements) {
      const signer = held.keys.find((key) => key.kid === endorsement.signer);
      if (signer === undefined) continue;
      const introduced = endorsedRoot(endorsement, signer, held.issuer);
      if (introduced === null) continue;
      root = introduced;
      break;
    }
  }
  if (root !== null) {
    // Each root is passed through once: two handovers naming each other are not followed in a circle.
    const passed = new Set<string>([root.kid]);
    for (let hop = 0; hop < MAX_ROOT_HANDOVERS; hop += 1) {
      const from: TrustedKey = root;
      let handedTo: TrustedKey | null = null;
      for (const endorsement of endorsements) {
        if (endorsement.signer !== from.kid) continue;
        const named = endorsedRoot(endorsement, from, held.issuer);
        if (named === null || passed.has(named.kid)) continue;
        handedTo = named;
        break;
      }
      if (handedTo === null) break;
      passed.add(handedTo.kid);
      root = handedTo;
    }
  }

  const rootChanged = root !== held.root;
  const settle = (refused: StatementRefusal): KeysetOutcome => ({
    next: rootChanged ? { ...held, root } : held,
    rootChanged,
    keysChanged: false,
    refused,
  });

  if (announced.statement === null) return settle("absent");
  if (root === null) return settle("no_root");
  const decoded = decodeSigned(announced.statement, KEYSET_TYP);
  if (!decoded.ok) return settle("unreadable");
  if (decoded.header.kid !== root.kid) return settle("wrong_root");
  const rootKey = jwkToPublicKey(root.jwk);
  if (rootKey === null || !verifySignature(decoded, rootKey)) return settle("bad_signature");
  const statement = parseKeysetStatement(decoded.payloadJson);
  if (statement === null) return settle("unreadable");
  if (statement.iss !== held.issuer) return settle("wrong_issuer");
  if (statement.v <= (held.keysetVersion ?? 0)) return settle("not_newer");
  if (statement.keys.length === 0) return settle("no_usable_keys");

  return {
    next: { issuer: held.issuer, keys: statement.keys, root, keysetVersion: statement.v },
    rootChanged,
    keysChanged: true,
    refused: null,
  };
}

function endorsedRoot(endorsement: Endorsement, signer: TrustedKey, issuer: string): TrustedKey | null {
  const key = jwkToPublicKey(signer.jwk);
  if (key === null || !verifySignature(endorsement.decoded, key)) return null;
  const payload = parseRootEndorsement(endorsement.decoded.payloadJson);
  if (payload === null || payload.iss !== issuer) return null;
  return payload.root;
}
