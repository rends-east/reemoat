import { MAX_ADDRESS_CHARS } from "./net.js";

// In memory by design: persisting would put an fsync per guess on the relay's database. Keys are built only by the builders below.

export interface ThrottleOptions {
  threshold: number;
  windowMs: number;
  baseBlockMs: number;
  maxBlockMs: number;
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  threshold: 5,
  windowMs: 15 * 60 * 1000,
  baseBlockMs: 30 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/** Per-address backstop against spraying distinct names; looser because a NAT or household shares the key. */
export const ADDRESS_THROTTLE: ThrottleOptions = {
  threshold: 30,
  windowMs: 15 * 60 * 1000,
  baseBlockMs: 30 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/** Counts successes: routes call fail() on the way to sending and never succeed(). */
export const MAIL_THROTTLE: ThrottleOptions = {
  threshold: 3,
  windowMs: 60 * 60 * 1000,
  baseBlockMs: 15 * 60 * 1000,
  maxBlockMs: 6 * 60 * 60 * 1000,
  maxEntries: 10_000,
};

/** Reset mail only, with no escalation, so nobody can hold an address's recovery mail shut. */
export const RESET_MAIL_THROTTLE: ThrottleOptions = {
  threshold: 3,
  windowMs: 60 * 60 * 1000,
  baseBlockMs: 15 * 60 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/** Bounds an authenticated caller's write cost, not guessing: generous, with a short non-escalating block. */
export const WRITE_THROTTLE: ThrottleOptions = {
  threshold: 60,
  windowMs: 60 * 1000,
  baseBlockMs: 10 * 1000,
  maxBlockMs: 10 * 1000,
  maxEntries: 10_000,
};

const PRUNE_EVERY = 256;

interface Entry {
  failures: number;
  firstAt: number;
  blockedUntil: number;
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Whole seconds, for `Retry-After`. Always at least 1 when blocked. */
  retryAfterSeconds: number;
}

const ALLOWED: ThrottleDecision = { allowed: true, retryAfterSeconds: 0 };

export class LoginThrottle {
  private readonly options: ThrottleOptions;
  private readonly entries = new Map<string, Entry>();
  private sincePrune = 0;

  constructor(options: Partial<ThrottleOptions> = {}) {
    this.options = { ...DEFAULT_THROTTLE, ...options };
  }

  /** Call before any database read or KDF work, and fail() before awaiting; succeed() undoes it. */
  check(key: string, now = Date.now()): ThrottleDecision {
    this.maybePrune(now);
    const entry = this.entries.get(normalize(key));
    if (entry === undefined) return ALLOWED;
    if (entry.blockedUntil <= now) return ALLOWED;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
    };
  }

  fail(key: string, now = Date.now()): void {
    const id = normalize(key);
    const existing = this.entries.get(id);

    const entry =
      existing === undefined || now - existing.firstAt > this.options.windowMs
        ? { failures: 0, firstAt: now, blockedUntil: 0 }
        : existing;

    entry.failures += 1;
    if (entry.failures > this.options.threshold) {
      const over = entry.failures - this.options.threshold - 1;
      // Clamp the exponent, not the product, so the multiplier can never reach Infinity.
      const doubling = 2 ** Math.min(over, 30);
      entry.blockedUntil = now + Math.min(this.options.baseBlockMs * doubling, this.options.maxBlockMs);
    }

    this.entries.set(id, entry);
    this.enforceCap(now);
  }

  /** Forgets every failure for this key, including the optimistic fail() recorded before verification. */
  succeed(key: string): void {
    this.entries.delete(normalize(key));
  }

  /**
   * Undoes one optimistic fail() on a key a crowd shares (addressKey), where succeed() would erase everyone's attempts.
   * Clears the block only once strictly under the threshold, so a forgive cannot lift a block another caller just armed.
   */
  forgive(key: string): void {
    const id = normalize(key);
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.failures = Math.max(0, entry.failures - 1);
    if (entry.failures < this.options.threshold) entry.blockedUntil = 0;
    if (entry.failures === 0) this.entries.delete(id);
    else this.entries.set(id, entry);
  }

  size(): number {
    return this.entries.size;
  }

  private maybePrune(now: number): void {
    this.sincePrune += 1;
    if (this.sincePrune < PRUNE_EVERY) return;
    this.sincePrune = 0;
    this.dropSettled(now);
  }

  private dropSettled(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.firstAt > this.options.windowMs) {
        this.entries.delete(id);
      }
    }
  }

  // Clearing the map lets maxEntries distinct keys flush a block; accepted over an unbounded map.
  private enforceCap(now: number): void {
    if (this.entries.size <= this.options.maxEntries) return;
    this.dropSettled(now);
    if (this.entries.size > this.options.maxEntries) this.entries.clear();
  }
}

function normalize(key: string): string {
  return key.trim().slice(0, MAX_KEY_CHARS).toLowerCase();
}

// Every key is namespaced, so an anonymous route can never write a key an authenticated route reads.

const LOGIN_NS = "login";
const ADDRESS_NS = "addr";
const PASSWORD_CHANGE_NS = "pwchg";
const REGISTER_NS = "reg";
const MAIL_NS = "mail";
const CONFIRM_NS = "confirm";
const RESET_NS = "reset";
const RESET_MAIL_NS = "resetmail";
const MAIL_TEST_NS = "mailtest";
const ENROLL_NS = "enroll";
const PROVISION_NS = "provision";
const WRITE_NS = "write";
const SEPARATOR = "|";

// Bounds the name half so normalize never cuts off the address half.
const MAX_NAME_KEY_CHARS = 120;

const MAX_EMAIL_KEY_CHARS = 254;

const keyChars = (namespace: string, ...fields: number[]): number =>
  namespace.length + fields.reduce((total, max) => total + SEPARATOR.length + max, 0);

/** The longest key any builder below can write, so normalize never cuts one; one row per builder. */
export const MAX_KEY_CHARS = Math.max(
  keyChars(LOGIN_NS, MAX_EMAIL_KEY_CHARS, MAX_ADDRESS_CHARS),
  keyChars(ADDRESS_NS, MAX_ADDRESS_CHARS),
  keyChars(PASSWORD_CHANGE_NS, MAX_NAME_KEY_CHARS),
  keyChars(REGISTER_NS, MAX_NAME_KEY_CHARS, MAX_ADDRESS_CHARS),
  keyChars(MAIL_NS, MAX_EMAIL_KEY_CHARS),
  keyChars(RESET_MAIL_NS, MAX_EMAIL_KEY_CHARS),
  keyChars(CONFIRM_NS, MAX_ADDRESS_CHARS),
  keyChars(RESET_NS, MAX_ADDRESS_CHARS),
  keyChars(MAIL_TEST_NS, MAX_NAME_KEY_CHARS),
  keyChars(ENROLL_NS, MAX_ADDRESS_CHARS),
  keyChars(PROVISION_NS, MAX_ADDRESS_CHARS),
  keyChars(WRITE_NS, MAX_NAME_KEY_CHARS, MAX_NAME_KEY_CHARS),
);

/** Separator-stripped, so caller-chosen halves cannot be re-cut into another key. */
function field(value: string, max: number): string {
  return normalize(value).slice(0, max).replaceAll(SEPARATOR, "_");
}

/** What was submitted (name or email) and from where; one account named two ways spends two counters. */
export function loginKey(identifier: string, address: string): string {
  return [LOGIN_NS, field(identifier, MAX_EMAIL_KEY_CHARS), field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/** Use with ADDRESS_THROTTLE and forgive(), never succeed(). */
export function addressKey(address: string): string {
  return [ADDRESS_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

export function passwordChangeKey(userId: string): string {
  return [PASSWORD_CHANGE_NS, field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}

/** Never succeed(): the recorded fail() is what bounds how many accounts one host may create. */
export function registerKey(name: string, address: string): string {
  return [REGISTER_NS, field(name, MAX_NAME_KEY_CHARS), field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/** Keyed on the recipient; POST /v1/forgot uses resetMailKey instead. */
export function mailKey(emailFolded: string): string {
  return [MAIL_NS, field(emailFolded, MAX_EMAIL_KEY_CHARS)].join(SEPARATOR);
}

/** The recipient's reset-mail budget; resetKey is the caller-keyed bound on guessing a link. */
export function resetMailKey(emailFolded: string): string {
  return [RESET_MAIL_NS, field(emailFolded, MAX_EMAIL_KEY_CHARS)].join(SEPARATOR);
}

export function confirmKey(address: string): string {
  return [CONFIRM_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

export function resetKey(address: string): string {
  return [RESET_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

export function mailTestKey(userId: string): string {
  return [MAIL_TEST_NS, field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}

export function enrollKey(address: string): string {
  return [ENROLL_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

export function provisionKey(address: string): string {
  return [PROVISION_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/** `what` must be a fixed literal at the call site, never derived from the request. */
export function writeKey(userId: string, what: string): string {
  return [WRITE_NS, field(what, MAX_NAME_KEY_CHARS), field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}
