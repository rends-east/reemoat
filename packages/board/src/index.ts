import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export * from "./apply.js";
export * from "./config.js";
export * from "./engine.js";
export * from "./guide.js";
export * from "./presets.js";
export * from "./rules.js";
export * from "./simulate.js";
export * from "./template.js";
export * from "./verdict.js";

/** Over the text byte for byte, comments and spacing included: two boards that read alike are still two revisions. */
export function boardHash(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Of two copies at one revision the smaller hash wins, so every daemon settles on the same one. */
export function newerBoard(a: { revision: number; hash: string }, b: { revision: number; hash: string }): boolean {
  return a.revision > b.revision || (a.revision === b.revision && a.hash < b.hash);
}
