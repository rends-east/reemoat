import {
  randomBytes,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * The one credential a human chooses, and therefore the only one that needs a KDF.
 *
 * Everything else in this service is 32 bytes from the CSPRNG behind a single
 * sha256 — correct there, because a 256-bit random value has no dictionary to run
 * against it. A password does, so it gets scrypt, and the two must never share a
 * function. See the note on `hashCredential` below; that one *trims*.
 *
 * **Inside this package on purpose.** `packages/control-plane/src` is copied
 * wholesale into the image, while every repo-root `src/` file the control plane
 * imports has to be named in `.dockerignore` *and* in the Dockerfile's COPY
 * lines — two lists that only `imagecheck` reconciles, in a separate CI job. This
 * module needs nothing but `node:crypto`, so putting it here costs nothing and
 * keeps that coupling from growing. It is also the wrong thing to share with the
 * daemon under any circumstances: a human credential has no business on the
 * machine that runs your agents.
 */

/**
 * Typed by hand, because `promisify` picks an overload and picks the wrong one.
 *
 * `scrypt` has a three-argument form and a four-argument one, and the inferred
 * signature is the three-argument shape — so `options` is silently not part of
 * the type. That matters more than usual here: `maxmem` is passed in every call
 * and dropping it is exactly the failure documented at MAX_MEM below, where
 * OpenSSL refuses N=2^15 against the 32 MiB default.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/* ------------------------------------------------------------------ *
 * Parameters
 * ------------------------------------------------------------------ */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * What a new hash is written with. Old hashes keep their own — see `verifyPassword`.
 *
 * N=2^15 costs ~51ms per hash on the machine this was measured on (Node 26,
 * 2026-08-07), against ~25ms at 2^14 and ~103ms at 2^16. The cost is paid on the
 * threadpool rather than the event loop, so it buys difficulty for an offline
 * attacker without buying latency for anybody else.
 */
export const CURRENT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const DK_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * **`maxmem` is passed explicitly, and it is not optional above N=2^14.**
 *
 * scrypt needs `128 · N · r` bytes and Node's default ceiling is 32 MiB, so
 * N=2^15 r=8 wants exactly 33,554,432 and OpenSSL refuses at the boundary:
 * measured, `scryptSync("pw", "salt", 32, {N: 32768, r: 8, p: 1})` throws
 * `error:030000AC:digital envelope routines::memory limit exceeded` while N=2^14
 * succeeds. A KDF that throws for some parameter sets and not others does not
 * look like a configuration error from the outside — it looks like a wrong
 * password, on one deployment, intermittently. So the ceiling is stated here
 * rather than inherited, with room for one raise of N before it has to move.
 */
const MAX_MEM = 128 * 1024 * 1024;

/**
 * The bounds on what may be hashed at all.
 *
 * The minimum is the only real defence against a guess; the maximum is not about
 * KDF cost — scrypt passes the input through one iteration of PBKDF2-HMAC-SHA256,
 * so length barely moves the curve, and the bcrypt folklore does not apply. It is
 * about not normalizing and storing a string somebody else sized. The body limit
 * on the route is the other half.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/**
 * **Which side of the credential gate a hash is being asked for.**
 *
 * `"public"` is anything reachable without a credential — today `POST /v1/login`
 * including its decoy, `POST /v1/register`, and `POST /v1/reset`. The last two
 * arrived with self-service recovery and they matter to the ceiling: the two
 * public slots are now shared three ways, so a registration flood and a login
 * flood contend. `"authenticated"` is everything the `/v1/*` gate has already
 * vetted: a password change, minting a key, the bootstrap hash. **Not** an admin
 * reset — that route is deleted.
 *
 * It is a required argument everywhere, with **no default**, and that is the
 * argument `LaunchOptions.fileIo` makes one package over: a default is how a
 * future route ends up on the wrong side of the gate silently, and the wrong
 * side here is the one an anonymous caller can flood.
 */
export type HashLane = "public" | "authenticated";

/**
 * How many hashes may be in flight, and the bound is **memory**, not CPU.
 *
 * At N=2^15 each hash holds `128 · N · r` = 32 MiB for its duration, so four is
 * ~134 MiB peak in a container that has whatever the host gave it. Unbounded, a
 * hundred simultaneous attempts is 3.2 GB and the process is killed rather than
 * slowed.
 *
 * It is also deliberately far below `UV_THREADPOOL_SIZE` (64, set in the image and
 * in the `cp` scripts). The threadpool is shared with `serveStatic`, which serves
 * the web bundle — so a gate at the pool's size would let a spray against this
 * very endpoint stop the login page loading, which is a denial of the remedy.
 */
const MAX_CONCURRENT = 4;

/**
 * How many of those four an unauthenticated caller may hold at once.
 *
 * **One gate was a starvation weapon.** The login route reaches the KDF on every
 * request by design — an unknown name verifies against the decoy so the timing
 * says nothing — so a spray of distinct names is a spray of real hashes. Measured
 * with a driver: 36 in flight, and every login *and* every admin password reset
 * answered `503 overloaded`. The throttle does not save it either, because
 * distinct names never reach a per-identity threshold; `throttle.ts`'s
 * `ADDRESS_THROTTLE` is the other half of this and neither is sufficient alone.
 *
 * Two of four, so an authenticated password change or an admin reset always has
 * somewhere to run, whatever is happening at the front door. The cost is stated
 * plainly: sign-in throughput is halved under no load at all, ~20 logins a second
 * against ~40. That is not a number anybody reaches — a fleet is one person and
 * their machines — and the thing being bought is that the remedy for a flood
 * stays reachable *during* the flood.
 */
const MAX_CONCURRENT_PUBLIC = 2;

/**
 * How many may wait, and past it the answer is "later" rather than a queue.
 *
 * The relay states the same rule for the same reason: a tunnel with no daemon is
 * a 503, never a queue, because holding requests turns an outage into a memory
 * leak during the incident it should survive. An unbounded wait list here would
 * do exactly that with an attacker holding the pen.
 *
 * **Per lane, not shared**, which is the one place the split changes a number
 * rather than only routing: 32 authenticated waiters plus 16 public ones is 48
 * at worst, against 32 before. A shared list would let a spray fill it and refuse
 * the password change anyway — the starvation moved one door along rather than
 * closed. Nothing is bought by the smaller total either: a waiter is a closure,
 * and the memory this file bounds is held by the four *running* hashes.
 */
const MAX_QUEUED = 32;

/** The public lane's share of the wait list. See `MAX_CONCURRENT_PUBLIC`. */
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

/** The total bound applies to both lanes; the sub-cap applies only to the public one. */
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
  // The slot is taken by `release` **on the waiter's behalf**, before it resolves
  // this promise, so there is no window between a slot falling free and the
  // woken caller claiming it. Incrementing after the await — which is what this
  // did — leaves the counters saying "three active" across a microtask turn in
  // which a fresh caller can walk straight past `hasRoom`.
  await new Promise<void>((resolve) => queue.push(resolve));
}

function release(lane: HashLane): void {
  active -= 1;
  if (lane === "public") activePublic -= 1;
  // **Authenticated first, unconditionally.** A fair queue would hand the freed
  // slot to whoever waited longest, which under a spray is always the sprayer —
  // exactly what the lane split refuses. A public waiter only runs when nothing
  // vetted is waiting for a slot it could use.
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

/* ------------------------------------------------------------------ *
 * The format
 * ------------------------------------------------------------------ */

/**
 * `scrypt$N$r$p$<salt base64url>$<dk base64url>` — one self-describing string.
 *
 * One column rather than six, and that is a consequence of this package having no
 * `migrate()`: raising N later must not need a schema change, or it cannot happen
 * at all. The format string *is* the migration mechanism here.
 *
 * More importantly it is what makes verification correct. The parameters read
 * back are the ones this row was **written** with, never the ones the process
 * currently prefers — which is the difference between raising N re-hashing people
 * gradually as they sign in, and raising N invalidating every password in the
 * fleet at once.
 */
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
  // A stored row naming parameters we would refuse to compute is not a password
  // we can check. Bounded here rather than at `scrypt`, which would throw.
  if (128 * N * r > MAX_MEM) return null;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const dk = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || dk.length === 0) return null;
  return { params: { N, r, p }, salt, dk };
}

/* ------------------------------------------------------------------ *
 * Normalization and policy
 * ------------------------------------------------------------------ */

/**
 * **NFKC, and never `trim()`.**
 *
 * `hashCredential` in `keys.ts` trims, which is right for a 43-character token
 * pasted out of a terminal with a stray newline and catastrophic here: a password
 * whose last character is a space would be stored trimmed and then compared
 * trimmed at every login, so it would appear to work — until the day somebody
 * types it into a field that does not trim. A password is bytes.
 *
 * Normalization is needed because the same password typed on an iOS keyboard and
 * on a laptop can be different byte sequences for the same characters. It is
 * applied by this one function at set time and at verify time, so the two cannot
 * drift apart.
 */
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
  // The one composition rule, and it is not a composition rule: it refuses the
  // single weak choice that actually gets made on a one-admin system, which is
  // the account name. Character-class rules are deliberately absent — they push
  // people to `Password1!` and buy nothing measurable.
  if (password.toLowerCase() === userName.trim().toLowerCase()) {
    return "password must not be the same as the user name";
  }
  return null;
}

/** 32 characters of base64url. For the bootstrap admin and for an admin reset. */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/* ------------------------------------------------------------------ *
 * Hashing and verification
 * ------------------------------------------------------------------ */

/** `lane` is required with no default — see `HashLane`. */
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

/** `lane` is required with no default — see `HashLane`. */
export async function verifyPassword(plain: string, stored: string, lane: HashLane): Promise<VerifyResult> {
  const decoded = decode(stored);
  if (decoded === null) return { ok: false, needsRehash: false };

  const password = normalizePassword(plain);
  const dk = await withSlot(lane, () =>
    scrypt(password, decoded.salt, decoded.dk.length, { ...decoded.params, maxmem: MAX_MEM }),
  );

  // Both sides are our own fixed-length output, so there is no length to leak —
  // but `timingSafeEqual` throws rather than returning false on a mismatch, and a
  // corrupt row must not crash a request. Same shape as `credentialMatches`.
  const ok = dk.length === decoded.dk.length && timingSafeEqual(dk, decoded.dk);
  const needsRehash =
    decoded.params.N !== CURRENT_PARAMS.N ||
    decoded.params.r !== CURRENT_PARAMS.r ||
    decoded.params.p !== CURRENT_PARAMS.p;
  return { ok, needsRehash };
}

/**
 * A hash of nothing anybody knows, built once, so a refusal costs what a
 * verification costs.
 *
 * Without it the login route is a user oracle: "no such user" would return in
 * microseconds while a real user's wrong password takes ~51ms, and the difference
 * is trivially measurable over a network. Every branch that cannot verify a real
 * password — unknown name, no password row, disabled account — verifies against
 * this instead, and takes the same concurrency slot doing it.
 *
 * **The same slot now means the same lane**, and that is why `lane` is threaded
 * through here rather than pinned to `"public"` inside. Time spent queued is time
 * the caller can measure, so a decoy waiting in one lane while a real
 * verification waits in another would rebuild the oracle out of the defence
 * against flooding — under load, and therefore exactly when somebody is looking.
 * Both halves of a login branch pass `"public"`; there is no caller that should
 * pass anything else, and the type is what says so rather than a default.
 *
 * `scryptSync` here and nowhere else: this runs once, at module load, before the
 * listener exists and before any tunnel is attached, so there is nothing on the
 * event loop to block. Everywhere else the synchronous form would stall the
 * process that carries every relay tunnel in the fleet.
 */
const DECOY_HASH = ((): string => {
  const salt = randomBytes(SALT_BYTES);
  const dk = scryptSync(randomBytes(32).toString("hex"), salt, DK_LENGTH, {
    ...CURRENT_PARAMS,
    maxmem: MAX_MEM,
  });
  return encode(CURRENT_PARAMS, salt, dk);
})();

/** Spend what a real verification spends, in the same lane, and answer nothing. */
export async function verifyAgainstDecoy(plain: string, lane: HashLane): Promise<void> {
  await verifyPassword(plain, DECOY_HASH, lane);
}
