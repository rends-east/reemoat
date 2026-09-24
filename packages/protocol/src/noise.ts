import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

// Noise_IK_25519_ChaChaPoly_BLAKE2s to revision 34 of the spec; protocolcheck drives it against the published vectors.
// dh is async because the app's static key stays in the OS keyring, behind the native bridge.

const KEY_BYTES = 32;

const HASH_BYTES = 32;

const TAG_BYTES = 16;

// 33 bytes, one over HASHLEN, so the spec hashes it rather than padding it into the initial h.
const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/** A static keypair whose private half may live where this process cannot read it (the app's device key). */
export interface StaticKey {
  readonly publicKey: Uint8Array;
  dh(peerPublicKey: Uint8Array): Promise<Uint8Array>;
}

/** An X25519 keypair this process holds outright. The daemon's machine key. */
export function localStaticKey(secretKey: Uint8Array): StaticKey {
  const publicKey = x25519.getPublicKey(secretKey);
  return {
    publicKey,
    dh: (peer: Uint8Array): Promise<Uint8Array> => Promise.resolve(x25519.getSharedSecret(secretKey, peer)),
  };
}

export function generateStaticKey(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Re-exported so consumers never import @noble themselves: pnpm's strict layout does not resolve it from them. */
export function publicFromSecret(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

export function randomSecretKey(): Uint8Array {
  return x25519.utils.randomSecretKey();
}

export interface Ephemeral {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

function randomEphemeral(): Ephemeral {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Noise's HKDF, not RFC 5869's: no info or length, and each output chains the previous one before the counter byte.
function hkdf(chainingKey: Uint8Array, material: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(blake2s, chainingKey, material);
  const first = hmac(blake2s, tempKey, Uint8Array.of(1));
  const second = hmac(blake2s, tempKey, concat(first, Uint8Array.of(2)));
  if (outputs === 2) return [first, second];
  return [first, second, hmac(blake2s, tempKey, concat(second, Uint8Array.of(3)))];
}

// 32 zero bits, then the 64-bit counter little-endian.
function nonceBytes(counter: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, counter, true);
  return out;
}

// Reserved by the spec (§5.1): the guards are >= so the last nonce that may seal anything is 2^64 - 2.
const RESERVED_NONCE = (1n << 64n) - 1n;

export class CipherState {
  private counter = 0n;

  constructor(private readonly key: Uint8Array | null) {}

  /** Drivers only: both transport ends start at zero, so a session must never call this. */
  static at(key: Uint8Array | null, counter: bigint): CipherState {
    if (counter < 0n || counter > RESERVED_NONCE) throw new Error("noise: a nonce outside the 64-bit range");
    const state = new CipherState(key);
    state.counter = counter;
    return state;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  /** What the next message will be sealed under. For assertions only. */
  get nonce(): bigint {
    return this.counter;
  }

  encrypt(associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) return plaintext;
    if (this.counter >= RESERVED_NONCE) throw new Error("noise: nonce exhausted");
    const sealed = chacha20poly1305(this.key, nonceBytes(this.counter), associatedData).encrypt(plaintext);
    this.counter += 1n;
    return sealed;
  }

  decrypt(associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === null) return ciphertext;
    if (this.counter >= RESERVED_NONCE) throw new Error("noise: nonce exhausted");
    // Advance only on success, or one injected bad frame would desynchronise the two ends for good.
    const opened = chacha20poly1305(this.key, nonceBytes(this.counter), associatedData).decrypt(ciphertext);
    this.counter += 1n;
    return opened;
  }
}

class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  cipher: CipherState = new CipherState(null);

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASH_BYTES) {
      const padded = new Uint8Array(HASH_BYTES);
      padded.set(name);
      this.hash = padded;
    } else {
      this.hash = blake2s(name);
    }
    this.chainingKey = this.hash;
  }

  mixKey(material: Uint8Array): void {
    const [chainingKey, temp] = hkdf(this.chainingKey, material, 2);
    this.chainingKey = chainingKey!;
    this.cipher = new CipherState(temp!.slice(0, KEY_BYTES));
  }

  mixHash(data: Uint8Array): void {
    this.hash = blake2s(concat(this.hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encrypt(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decrypt(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, new Uint8Array(0), 2);
    return [new CipherState(first!.slice(0, KEY_BYTES)), new CipherState(second!.slice(0, KEY_BYTES))];
  }
}

export interface NoiseTransport {
  send: CipherState;
  receive: CipherState;
  /** `h` at the end of the handshake. The channel binding, if one is ever wanted. */
  handshakeHash: Uint8Array;
}

export interface NoiseOptions {
  initiator: boolean;
  staticKey: StaticKey;
  /** The responder's static public key. Required of an initiator — IK knows it. */
  remoteStatic?: Uint8Array | undefined;
  prologue?: Uint8Array | undefined;
  /** Pinned by the vectors, random everywhere else. */
  ephemeral?: (() => Ephemeral) | undefined;
}

// IK: pre-message <- s; then -> e, es, s, ss and <- e, ee, se.
type Token = "e" | "s" | "ee" | "es" | "se" | "ss";
const MESSAGES: readonly (readonly Token[])[] = [
  ["e", "es", "s", "ss"],
  ["e", "ee", "se"],
];

export class NoiseHandshake {
  private readonly symmetric: SymmetricState;
  private readonly newEphemeral: () => Ephemeral;
  private ephemeral: Ephemeral | null = null;
  private remoteStatic: Uint8Array | null;
  private remoteEphemeral: Uint8Array | null = null;
  private step = 0;
  private transport: NoiseTransport | null = null;

  private constructor(
    private readonly initiator: boolean,
    private readonly staticKey: StaticKey,
    remoteStatic: Uint8Array | null,
    prologue: Uint8Array,
    newEphemeral: () => Ephemeral,
  ) {
    this.remoteStatic = remoteStatic;
    this.newEphemeral = newEphemeral;
    this.symmetric = new SymmetricState(PROTOCOL_NAME);
    this.symmetric.mixHash(prologue);
    // IK's one pre-message is the responder's static key, and both ends mix it.
    this.symmetric.mixHash(initiator ? remoteStatic! : staticKey.publicKey);
  }

  static start(options: NoiseOptions): NoiseHandshake {
    if (options.initiator && (options.remoteStatic === undefined || options.remoteStatic.length !== KEY_BYTES)) {
      throw new Error("noise: an IK initiator needs the responder's static key");
    }
    return new NoiseHandshake(
      options.initiator,
      options.staticKey,
      options.remoteStatic ?? null,
      options.prologue ?? new Uint8Array(0),
      options.ephemeral ?? randomEphemeral,
    );
  }

  get complete(): boolean {
    return this.transport !== null;
  }

  /** Set once the handshake authenticates it; on the daemon this is the device key compared with the capability's. */
  get remoteStaticKey(): Uint8Array | null {
    return this.remoteStatic;
  }

  private async mixDh(token: Token): Promise<void> {
    const local = this.initiator;
    switch (token) {
      case "ee":
        this.symmetric.mixKey(x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteEphemeral!));
        return;
      case "es":
        this.symmetric.mixKey(
          local
            ? x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteStatic!)
            : await this.staticKey.dh(this.remoteEphemeral!),
        );
        return;
      case "se":
        this.symmetric.mixKey(
          local
            ? await this.staticKey.dh(this.remoteEphemeral!)
            : x25519.getSharedSecret(this.ephemeral!.secretKey, this.remoteStatic!),
        );
        return;
      case "ss":
        this.symmetric.mixKey(await this.staticKey.dh(this.remoteStatic!));
        return;
      default:
        throw new Error(`noise: ${token} is not a DH token`);
    }
  }

  async writeMessage(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
    const tokens = MESSAGES[this.step];
    if (tokens === undefined) throw new Error("noise: the handshake has no more messages to write");
    if (this.step % 2 === 0 !== this.initiator) throw new Error("noise: it is the other end's turn to write");

    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      if (token === "e") {
        this.ephemeral = this.newEphemeral();
        parts.push(this.ephemeral.publicKey);
        this.symmetric.mixHash(this.ephemeral.publicKey);
      } else if (token === "s") {
        parts.push(this.symmetric.encryptAndHash(this.staticKey.publicKey));
      } else {
        await this.mixDh(token);
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload));
    this.step += 1;
    this.maybeSplit();
    return concat(...parts);
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = MESSAGES[this.step];
    if (tokens === undefined) throw new Error("noise: the handshake has no more messages to read");
    if (this.step % 2 === 0 === this.initiator) throw new Error("noise: it is this end's turn to write");

    let rest = message;
    const take = (n: number): Uint8Array => {
      if (rest.length < n) throw new Error("noise: handshake message is short");
      const head = rest.subarray(0, n);
      rest = rest.subarray(n);
      return head;
    };

    for (const token of tokens) {
      if (token === "e") {
        this.remoteEphemeral = take(KEY_BYTES);
        this.symmetric.mixHash(this.remoteEphemeral);
      } else if (token === "s") {
        const sealed = take(this.symmetric.cipher.hasKey ? KEY_BYTES + TAG_BYTES : KEY_BYTES);
        this.remoteStatic = this.symmetric.decryptAndHash(sealed);
      } else {
        await this.mixDh(token);
      }
    }
    const payload = this.symmetric.decryptAndHash(rest);
    this.step += 1;
    this.maybeSplit();
    return payload;
  }

  private maybeSplit(): void {
    if (this.step < MESSAGES.length) return;
    const [first, second] = this.symmetric.split();
    // c1 is always initiator to responder, so the pair is oriented here and never at a call site.
    this.transport = this.initiator
      ? { send: first, receive: second, handshakeHash: this.symmetric.hash }
      : { send: second, receive: first, handshakeHash: this.symmetric.hash };
  }

  split(): NoiseTransport {
    if (this.transport === null) throw new Error("noise: the handshake is not finished");
    return this.transport;
  }
}
