import { MAX_KEYSET_ENDORSEMENTS, MAX_ROOT_HANDOVERS } from "./relay/protocol.js";
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

// What a relay announced on a dial, weighed against what this machine already trusts. The weighing is pure: no clock, no store, no network.
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

interface Endorsement {
  signer: string;
  decoded: Extract<DecodedToken, { ok: true }>;
}

export function weighAnnouncement(held: KeysetHeld, announced: KeysetAnnouncement): KeysetOutcome {
  const endorsements: Endorsement[] = [];
  for (const text of announced.endorsements.slice(0, MAX_KEYSET_ENDORSEMENTS)) {
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

/** The identity fields a statement moves; whatever else the stored row carries rides along untouched. */
export interface StoredKeyset {
  issuer: string;
  keys: TrustedKey[];
  root: TrustedKey | null;
  keysetVersion: number | null;
}

export interface KeysetTakerOptions<T extends StoredKeyset> {
  held: T;
  store: { save(identity: T): void };
  verifier: { replaceKeys(keys: readonly TrustedKey[]): boolean };
  /** Once per reason until a set is taken: every redial would say it again. Never for `absent` or `not_newer`. */
  onRefused?: (reason: StatementRefusal) => void;
  onRootChanged?: (root: TrustedKey | null) => void;
  onKeysTaken?: (held: T) => void;
  /** Once until a save lands. */
  onSaveFailed?: (error: unknown) => void;
}

export interface KeysetTaker<T extends StoredKeyset> {
  held(): T;
  keysetVersion(): number | null;
  /** Throws when what it weighed could not be stored: nothing was taken, and the caller may offer it again. */
  onKeyset(announced: KeysetAnnouncement): void;
}

/** Saved before it takes effect, so a restart never verifies against a key set the store does not hold. */
export function createKeysetTaker<T extends StoredKeyset>(options: KeysetTakerOptions<T>): KeysetTaker<T> {
  let held = options.held;
  let lastRefusal: StatementRefusal | null = null;
  let saveFailing = false;
  return {
    held: () => held,
    keysetVersion: () => held.keysetVersion,
    onKeyset(announced) {
      const outcome = weighAnnouncement(held, announced);
      if (outcome.refused !== null && outcome.refused !== "absent" && outcome.refused !== "not_newer") {
        if (lastRefusal !== outcome.refused) options.onRefused?.(outcome.refused);
        lastRefusal = outcome.refused;
      }
      if (outcome.next === held) return;
      const next: T = { ...held, keys: [...outcome.next.keys], root: outcome.next.root, keysetVersion: outcome.next.keysetVersion };
      try {
        options.store.save(next);
      } catch (error) {
        if (!saveFailing) options.onSaveFailed?.(error);
        saveFailing = true;
        throw error;
      }
      saveFailing = false;
      held = next;
      if (outcome.rootChanged) options.onRootChanged?.(next.root);
      if (outcome.keysChanged) {
        options.verifier.replaceKeys(next.keys);
        lastRefusal = null;
        options.onKeysTaken?.(next);
      }
    },
  };
}
