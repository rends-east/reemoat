import { blake2s } from "@noble/hashes/blake2.js";

// What a person reads off two screens. One copy for both ends: a code computed two ways agrees with nothing.

// Crockford's alphabet: no I, L, O or U, so a code read aloud or retyped has one spelling.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encoder = new TextEncoder();

/** 50 bits over one key: matching somebody's code is a second preimage, 2^50 key generations (Q1.656). */
const APPROVAL_CODE_CHARS = 10;

/** 80 bits, in four groups of four: the most that stays whole beside its label on a phone, and far past grinding. */
const FINGERPRINT_CHARS = 16;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let held = 0;
  let bits = 0;
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(held >> (bits - 5)) & 31];
      bits -= 5;
    }
    held &= (1 << bits) - 1;
    if (out.length === chars) break;
  }
  return out;
}

function grouped(text: string, size: number): string {
  return text.match(new RegExp(`.{1,${String(size)}}`, "g"))?.join("-") ?? text;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error("a key is 32 bytes");
}

/** The asking key alone: a second key in it is a second thing one party may choose, and equal codes then cost 2^25 (Q1.656). */
export function approvalCode(initiator: Uint8Array): string {
  assertKey(initiator);
  const digest = blake2s(concat(encoder.encode("reemoat/approve/2"), initiator));
  return grouped(base32(digest, APPROVAL_CODE_CHARS), 5);
}

/** One key, for comparing by eye against what the machine itself prints. */
export function keyFingerprint(key: Uint8Array): string {
  assertKey(key);
  return grouped(base32(blake2s(concat(encoder.encode("reemoat/key/1"), key)), FINGERPRINT_CHARS), 4);
}
