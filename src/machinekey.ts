import { generateStaticKey, localStaticKey } from "@reemoat/protocol";
import type { StaticKey } from "@reemoat/protocol";
import { jwkThumbprint, x25519Jwk } from "./token.js";
import type { SqliteMachineKeyStore, StoredMachineKey } from "./store/sqlite.js";

/**
 * Generated here and never elsewhere, and announced on the dial rather than asked for.
 * A second live row is refused twice: by the daemon lock and by the machine_keys_one_live index.
 */
export function ensureMachineKey(store: SqliteMachineKeyStore, now = Date.now()): StoredMachineKey {
  const existing = store.active();
  if (existing !== null) return existing;

  const { secretKey, publicKey } = generateStaticKey();
  const fresh = {
    kth: jwkThumbprint(x25519Jwk(publicKey)),
    publicKey: Buffer.from(publicKey).toString("base64url"),
    privateKey: Buffer.from(secretKey).toString("base64url"),
    createdAt: now,
  };
  store.save(fresh);

  // Read back: a racing INSERT is refused by machine_keys_one_live, so the winner's row, not fresh, is the machine's key.
  const stored = store.active();
  if (stored === null) throw new Error("the machine key could not be read back after writing it");
  return stored;
}

export interface AnnouncedMachineKey {
  kth: string;
  machineKey: string;
  /** The private half, as the Noise responder needs it. Never leaves this process. */
  staticKey: StaticKey;
}

export function announceableMachineKey(key: StoredMachineKey): AnnouncedMachineKey {
  return {
    kth: key.kth,
    machineKey: key.publicKey,
    staticKey: localStaticKey(new Uint8Array(Buffer.from(key.privateKey, "base64url"))),
  };
}

/** After a 409, promotes and announces the next key this machine holds, each tried once per process; a single-key machine gets null at once. */
export function machineKeyRotation(
  store: SqliteMachineKeyStore,
  announcing: StoredMachineKey,
): () => AnnouncedMachineKey | null {
  const tried = new Set<string>([announcing.kth]);
  return () => {
    for (const candidate of store.all()) {
      if (tried.has(candidate.kth)) continue;
      tried.add(candidate.kth);
      // False means the row vanished, so move on; a store throw is answered as null by the tunnel's 409 arm, and tried is already updated.
      if (!store.promote(candidate.kth)) continue;
      return announceableMachineKey(candidate);
    }
    return null;
  };
}
