import { blake2s } from "@noble/hashes/blake2.js";

// What a person reads off two screens. One copy for both ends: a code computed two ways agrees with nothing.

// Crockford's alphabet: no I, L, O or U, so a code read aloud or retyped has one spelling.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encoder = new TextEncoder();

/** 50 bits. Shorter, and a key ground to collide with somebody's code costs an afternoon rather than a datacentre (Q1.656). */
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

/** Both keys are in it: the one asking and the machine it believes it is asking, so swapping either shows as two different codes. */
export function approvalCode(initiator: Uint8Array, machine: Uint8Array): string {
  assertKey(initiator);
  assertKey(machine);
  const digest = blake2s(concat(encoder.encode("reemoat/approve/1"), initiator, machine));
  return grouped(base32(digest, APPROVAL_CODE_CHARS), 5);
}

/** One key, for comparing by eye against what the machine itself prints. */
export function keyFingerprint(key: Uint8Array): string {
  assertKey(key);
  return grouped(base32(blake2s(concat(encoder.encode("reemoat/key/1"), key)), FINGERPRINT_CHARS), 4);
}
