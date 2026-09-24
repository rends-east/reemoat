import {
  randomBytes,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

// Typed by hand: promisify infers the three-argument overload, which drops options and with them maxmem.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const CURRENT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const DK_LENGTH = 32;
const SALT_BYTES = 16;

// Explicit: at N=2^15, r=8 scrypt needs exactly Node's 32 MiB default and OpenSSL refuses it.
const MAX_MEM = 128 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Which side of the credential gate a hash is for. Required with no default, so a new route cannot silently land in the floodable lane. */
export type HashLane = "public" | "authenticated";

// Bounded by memory (32 MiB per hash), and far below UV_THREADPOOL_SIZE because serveStatic shares that pool.
const MAX_CONCURRENT = 4;

// Unauthenticated callers get at most half the slots, so a password change still runs during a login spray.
const MAX_CONCURRENT_PUBLIC = 2;

// Past this the answer is 503, never an unbounded queue; per lane, so a spray cannot fill the authenticated list.
const MAX_QUEUED = 32;

const MAX_QUEUED_PUBLIC = 16;

/** Raised when the queue is full. Handlers answer `503 overloaded`. */
export class PasswordBusyError extends Error {
  constructor() {
    super("too many password verifications in flight");
    this.name = "PasswordBusyError";
  }
}

let active = 0;
let activePublic = 0;
const waitingPublic: (() => void)[] = [];
const waitingAuthenticated: (() => void)[] = [];

function queueOf(lane: HashLane): (() => void)[] {
  return lane === "public" ? waitingPublic : waitingAuthenticated;
}

function hasRoom(lane: HashLane): boolean {
  if (active >= MAX_CONCURRENT) return false;
  return lane === "authenticated" || activePublic < MAX_CONCURRENT_PUBLIC;
}

function take(lane: HashLane): void {
  active += 1;
  if (lane === "public") activePublic += 1;
}

async function acquire(lane: HashLane): Promise<void> {
  if (hasRoom(lane)) {
    take(lane);
    return;
  }
  const queue = queueOf(lane);
  if (queue.length >= (lane === "public" ? MAX_QUEUED_PUBLIC : MAX_QUEUED)) throw new PasswordBusyError();
  // release takes the slot on the waiter's behalf before resolving, so a fresh caller cannot slip past hasRoom in between.
  await new Promise<void>((resolve) => queue.push(resolve));
}

function release(lane: HashLane): void {
  active -= 1;
  if (lane === "public") activePublic -= 1;
  // Authenticated waiters first, unconditionally: a fair queue would hand every freed slot to the sprayer.
  if (wake("authenticated")) return;
  wake("public");
}

function wake(lane: HashLane): boolean {
  if (!hasRoom(lane)) return false;
  const next = queueOf(lane).shift();
  if (next === undefined) return false;
  take(lane);
  next();
  return true;
}

async function withSlot<T>(lane: HashLane, run: () => Promise<T>): Promise<T> {
  await acquire(lane);
  try {
    return await run();
  } finally {
    release(lane);
  }
}

// Self-describing: verification uses the parameters the row was written with, so raising N re-hashes people as they sign in.
function encode(params: ScryptParams, salt: Buffer, dk: Buffer): string {
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    dk.toString("base64url"),
  ].join("$");
}

interface Decoded {
  params: ScryptParams;
  salt: Buffer;
  dk: Buffer;
}

/** `null` for anything this module did not write. A corrupt row is a refusal, never a throw. */
function decode(stored: string): Decoded | null {
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  if (parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || r < 1 || p < 1) return null;
  // A row naming parameters over MAX_MEM cannot be checked; refused here because scrypt would throw.
  if (128 * N * r > MAX_MEM) return null;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const dk = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || dk.length === 0) return null;
  return { params: { N, r, p }, salt, dk };
}

/** NFKC and never trim: a trailing space is part of a password. Applied at set and at verify time alike. */
export function normalizePassword(raw: string): string {
  return raw.normalize("NFKC");
}

/** `null` when acceptable, otherwise the sentence to put in the 400. */
export function checkPasswordPolicy(raw: unknown, userName: string): string | null {
  if (typeof raw !== "string") return "password must be a string";
  const password = normalizePassword(raw);
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (password.toLowerCase() === userName.trim().toLowerCase()) {
    return "password must not be the same as the user name";
  }
  return null;
}

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function hashPassword(plain: string, lane: HashLane): Promise<string> {
  const password = normalizePassword(plain);
  const salt = randomBytes(SALT_BYTES);
  const dk = await withSlot(lane, () => scrypt(password, salt, DK_LENGTH, { ...CURRENT_PARAMS, maxmem: MAX_MEM }));
  return encode(CURRENT_PARAMS, salt, dk);
}

export interface VerifyResult {
  ok: boolean;
  /** The stored row used parameters we no longer write. Re-hash after a success. */
  needsRehash: boolean;
}

export async function verifyPassword(plain: string, stored: string, lane: HashLane): Promise<VerifyResult> {
  const decoded = decode(stored);
  if (decoded === null) return { ok: false, needsRehash: false };

  const password = normalizePassword(plain);
  const dk = await withSlot(lane, () =>
    scrypt(password, decoded.salt, decoded.dk.length, { ...decoded.params, maxmem: MAX_MEM }),
  );

  // timingSafeEqual throws on a length mismatch, and a corrupt row must not crash a request.
  const ok = dk.length === decoded.dk.length && timingSafeEqual(dk, decoded.dk);
  const needsRehash =
    decoded.params.N !== CURRENT_PARAMS.N ||
    decoded.params.r !== CURRENT_PARAMS.r ||
    decoded.params.p !== CURRENT_PARAMS.p;
  return { ok, needsRehash };
}

// Unknown names, missing rows and disabled accounts verify against this in the same lane, so timing is no user oracle.
// scryptSync only here: it runs once at module load, before any listener exists.
const DECOY_HASH = ((): string => {
  const salt = randomBytes(SALT_BYTES);
  const dk = scryptSync(randomBytes(32).toString("hex"), salt, DK_LENGTH, {
    ...CURRENT_PARAMS,
    maxmem: MAX_MEM,
  });
  return encode(CURRENT_PARAMS, salt, dk);
})();

export async function verifyAgainstDecoy(plain: string, lane: HashLane): Promise<void> {
  await verifyPassword(plain, DECOY_HASH, lane);
}
