import { MAX_ADDRESS_CHARS } from "./net.js";

/**
 * What stops somebody guessing a password.
 *
 * The KDF is what makes a *stolen database* expensive; this is what makes a live
 * guessing attempt expensive. Both are needed and neither substitutes for the
 * other: scrypt at 50ms would still let an attacker try twenty passwords a second
 * for ever, which is a weekend's work against anything a human chose.
 *
 * **Keyed on the name that was submitted, whether or not anybody has it.** That is
 * what lets the refusal be an honest `429` rather than a silent 401: if the
 * throttle only existed for real accounts then being throttled would prove an
 * account exists, and the status would be an enumeration oracle. Keyed on the
 * submitted string, a `429` says only "you have been guessing", which the guesser
 * already knows.
 *
 * **In memory, and a restart clears it.** Two reasons, and the second is the one
 * that decides. The first is the precedent this repo states three times for
 * auto-resume retry state: a restart is *new information*. The second is that this
 * database runs `PRAGMA synchronous = FULL` and lives in the process that carries
 * every relay tunnel — so persisting a counter per failed guess would convert an
 * attacker's guesses into fsyncs on the fleet's identity service, and the defence
 * would become the outage it was meant to prevent.
 *
 * **It must never become a lockout weapon, and keyed on the bare name it was
 * one.** Measured with a driver: eleven unauthenticated `POST /v1/login` requests
 * naming `ada` made ada's own sign-in answer `429` **with the correct password**,
 * and made her password change answer `429` on a valid session — one throttle
 * instance, one key, two routes. Sustaining it cost about eleven requests every
 * fifteen minutes. The escape hatch this file used to name did not exist either:
 * a user created today gets no API key, so "somebody locked out of the web UI
 * still has `cpctl`" was true only of the bootstrap admin.
 *
 * So **a key is composed, and the builders below are the only place the
 * composition lives**. `loginKey` pairs the submitted name with the address it
 * arrived from, so a block follows the guesser instead of the name.
 * `passwordChangeKey` is namespaced on the user id, so nothing an anonymous
 * caller records can reach an authenticated route. `addressKey` is the backstop,
 * because a per-identity counter on its own lets one address spray a thousand
 * distinct names and never meet a threshold — which is what
 * `ADDRESS_THROTTLE` is for.
 *
 * `relay/authorize.ts` records the same failure once from the other direction:
 * its key cache was tightened from ten seconds to one because a bogus `kid`
 * could warm the throttle and make *valid* tokens fail for the rest of the
 * window. So what a block costs here stays bounded and short, it never disables
 * an account, and it never touches the API key path.
 *
 * **What the address half is worth, said plainly, because it is easy to read as
 * more than it is.**
 *
 * Behind a reverse proxy that does not set `x-forwarded-for`, every caller shares
 * the proxy's socket address — `callerAddressOf` has nothing else to answer — so
 * `loginKey` degrades back toward one bucket per name and `addressKey` degrades
 * toward a global counter. An office behind one NAT is the same shape without a
 * proxy at all. That direction of failure is the safe one for guessing and the
 * unsafe one for lockout, which is why the block is minutes rather than an
 * account state.
 *
 * Where there is no proxy the header is caller-supplied and *wins*, so a sprayer
 * can mint a fresh bucket per request and can also aim at somebody's real
 * address if they know it. Neither is a regression: today's key needs neither.
 * What the composition buys is that a block is now at worst as narrow as the
 * address somebody chose, instead of fleet-wide for a name anybody can type.
 *
 * An attacker spread across many addresses is therefore **not** bounded by this
 * file. What bounds them is `password.ts`'s public lane — four hashes in flight
 * fleet-wide, two of them reachable without a credential — so the spray is
 * refused as `503 overloaded` rather than allowed to starve an admin reset. The
 * two defences are stacked deliberately and neither substitutes for the other.
 */

export interface ThrottleOptions {
  /** Failures tolerated inside `windowMs` before anything is blocked. */
  threshold: number;
  /** How long failures are remembered. */
  windowMs: number;
  /** The first block, doubled per failure past the threshold. */
  baseBlockMs: number;
  /** The longest a block may last, however many failures there have been. */
  maxBlockMs: number;
  /** How many distinct keys are tracked before the table is swept. */
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  threshold: 5,
  windowMs: 15 * 60 * 1000,
  baseBlockMs: 30 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/**
 * The per-address backstop, and it is looser on purpose.
 *
 * `DEFAULT_THROTTLE` counts failures against one identity, which is the right
 * shape for somebody guessing one password and the wrong shape for somebody
 * spraying: a thousand requests naming a thousand distinct names never reaches a
 * per-identity threshold, so today they cost nothing and reach the KDF every
 * time. Six failures from one address is a person; thirty is not.
 *
 * Thirty rather than five because this key is **shared by everybody who appears
 * to be at that address** — a NAT, a proxy that forwards nothing, a household.
 * Five would make one person's bad afternoon everybody else's lockout, which is
 * the failure the header of this file exists to prevent. The block is the same
 * length as the per-identity one, for the same reason: bounded and short.
 *
 * A `maxEntries` of ten thousand is the same number as the identity table and
 * costs the same admission: somebody with ten thousand addresses can flush it,
 * which lowers the wall rather than removing it. See `enforceCap`.
 */
export const ADDRESS_THROTTLE: ThrottleOptions = {
  threshold: 30,
  windowMs: 15 * 60 * 1000,
  baseBlockMs: 30 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/**
 * How much mail one address may be sent, and it counts **successes**.
 *
 * A third instance for the reason there is a second one: two thresholds means
 * two instances, and there is no arrangement of one that is right for both jobs.
 * Feeding a recipient key into `DEFAULT_THROTTLE` would allow five messages in
 * fifteen minutes — far too many for a mail bomb — while feeding an address key
 * into this one would block a sign-in after three wrong passwords.
 *
 * It also counts a different *event* from everything else in this file. Every
 * other counter here counts failures, because a failure is what a guess looks
 * like. A mail bomb is a sequence of **successes**: each request works
 * perfectly, and the harm is that it worked. So the routes call `fail()` on the
 * way to sending rather than on refusing, and never call `succeed()`.
 *
 * Three an hour, blocking up to six: somebody who genuinely did not receive a
 * message asks twice and then reads the sentence about checking spam. The
 * long ceiling is because the victim is not the caller — there is nobody at the
 * blocked end to inconvenience by making it longer.
 */
export const MAIL_THROTTLE: ThrottleOptions = {
  threshold: 3,
  windowMs: 60 * 60 * 1000,
  baseBlockMs: 15 * 60 * 1000,
  maxBlockMs: 6 * 60 * 60 * 1000,
  maxEntries: 10_000,
};

/**
 * The same job for reset mail alone, and a **fourth** instance is the point.
 *
 * `MAIL_THROTTLE` is shared across the routes that mail, so they cannot compose
 * into a message each. That sharing is
 * right for everything it bounds except one: since the admin reset was deleted,
 * `POST /v1/forgot` **is** the recovery, and the key it spends follows the
 * *victim* rather than the caller. So anybody who knew an address could fill
 * that address's budget from anywhere with no credential — three anonymous
 * requests, then a doubling block up to six hours, sustained indefinitely by a
 * handful a day — and `/v1/forgot` answers `{sent: true}` throughout, so the
 * person is told their mail is on the way while nothing is sent and no other
 * remedy exists. Non-adversarially it is the same shape: somebody who clicks
 * "Forgot password" four times because the first mail was slow locks themselves
 * out of the only door they have.
 *
 * Two differences from `MAIL_THROTTLE`, each doing one job. Its **own
 * namespace**, so a flood of registrations or verifications against an address
 * cannot close its owner's way back in. And **no escalation** — `maxBlockMs`
 * equals `baseBlockMs` — because escalation is what turns "wait a few minutes"
 * into a lockout somebody can hold open. A mail bomb down this route is still
 * bounded at roughly four an hour, which is what the bound is for; what it can
 * no longer do is take recovery away.
 */
export const RESET_MAIL_THROTTLE: ThrottleOptions = {
  threshold: 3,
  windowMs: 60 * 60 * 1000,
  baseBlockMs: 15 * 60 * 1000,
  maxBlockMs: 15 * 60 * 1000,
  maxEntries: 10_000,
};

/**
 * What one signed-in account may write per minute, and a **fifth** instance
 * because this one counts a different kind of thing.
 *
 * Every other policy here bounds *guessing*: a threshold of 3 or 5 with an
 * escalating block, which is right when each attempt is an attack and wrong when
 * each attempt is somebody working. This bounds *cost* — an fsync and a row that
 * nothing prunes — so it is generous per minute and forgets quickly.
 *
 * 60 in a minute is far above any human at a keyboard and far above the web
 * client, which mints one token per machine per ~210s; a script enrolling twenty
 * hosts never touches it either, because that is twenty requests. What it stops
 * is the loop, and it stops it at a rate where the volume no longer matters.
 *
 * The block is deliberately short and does **not** escalate. A doubling block is
 * how you punish a guesser; this caller is authenticated and much more likely to
 * be a retry loop somebody wrote badly than an attacker, and the remedy is for it
 * to slow down rather than to be locked out of its own machines.
 */
export const WRITE_THROTTLE: ThrottleOptions = {
  threshold: 60,
  windowMs: 60 * 1000,
  baseBlockMs: 10 * 1000,
  maxBlockMs: 10 * 1000,
  maxEntries: 10_000,
};

/**
 * The longest key this will store.
 *
 * Capped **before** insertion rather than validated at the route, because the map
 * is keyed by a string an unauthenticated caller chose: without this, the defence
 * against guessing is a way to make the process hold as much memory as somebody
 * cares to send.
 *
 * ⚠ **It has to sit above the longest key the builders below can compose, and at
 * 200 it did not.** `normalize` slices the whole key at this number, and `field`
 * calls `normalize` *first* — so `MAX_EMAIL_KEY_CHARS` (254) was unreachable, its
 * `.slice` a no-op, and every address was cut at 200 twice over: once as a field,
 * once as the composed key. Two addresses sharing their first 200 characters then
 * shared one mail-bomb counter, which is precisely the shared-counter failure
 * `MAX_EMAIL_KEY_CHARS` was introduced to end. The docblock there stated the
 * arithmetic that proves it — "264, still comfortably under `MAX_KEY_CHARS`" —
 * against a `MAX_KEY_CHARS` of 200, so the comment was the bug written down.
 *
 * 320 is that 264 with room, and it changes nothing about *why* the cap exists:
 * a bound on what an anonymous caller can make this map hold per entry. What
 * `users.name`'s own 200-character validation bounds is the name half, and
 * `MAX_NAME_KEY_CHARS` is what applies it.
 */
const MAX_KEY_CHARS = 320;

/** How many `check` calls between opportunistic sweeps. Prune is lazy; there is no timer. */
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

  /**
   * May this attempt proceed?
   *
   * Called **before** any database read and before any KDF work, so a blocked
   * caller costs a map lookup rather than 50ms of threadpool and a query.
   *
   * Answering this is not the same as recording an attempt, and the caller must
   * do both **before** it awaits — see `succeed`, which is what undoes the
   * record when the password turns out to be right.
   */
  check(key: string, now = Date.now()): ThrottleDecision {
    this.maybePrune(now);
    const entry = this.entries.get(normalize(key));
    if (entry === undefined) return ALLOWED;
    if (entry.blockedUntil <= now) return ALLOWED;
    return {
      allowed: false,
      // Rounded up: a `Retry-After: 0` invites an immediate retry that is refused
      // again, which reads as the header being wrong rather than the wait being short.
      retryAfterSeconds: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)),
    };
  }

  /** Record a failed attempt. */
  fail(key: string, now = Date.now()): void {
    const id = normalize(key);
    const existing = this.entries.get(id);

    // A window that has elapsed starts again rather than accumulating for ever:
    // five wrong guesses spread over a year is somebody's memory, not an attack.
    const entry =
      existing === undefined || now - existing.firstAt > this.options.windowMs
        ? { failures: 0, firstAt: now, blockedUntil: 0 }
        : existing;

    entry.failures += 1;
    if (entry.failures > this.options.threshold) {
      const over = entry.failures - this.options.threshold - 1;
      // **The exponent is what is bounded.** `2 ** over` doubles per failure, so
      // a long-running attack would otherwise ask for a number no ceiling can be
      // applied to; clamping `over` at 30 caps the multiplier at 2^30 and makes
      // `Infinity` unreachable on its own. This used to clamp the *product*
      // against `maxBlockMs` here as well — a dimensionless multiplier compared
      // against a millisecond duration, which was harmless only because the
      // ceiling below re-applies itself to the real duration a line later.
      const doubling = 2 ** Math.min(over, 30);
      entry.blockedUntil = now + Math.min(this.options.baseBlockMs * doubling, this.options.maxBlockMs);
    }

    this.entries.set(id, entry);
    this.enforceCap(now);
  }

  /**
   * Record a success, and forget the failures.
   *
   * Somebody who got it right on the sixth try is somebody who mistyped it five
   * times, and leaving their counter armed means the next mistyped attempt blocks
   * them for no reason.
   *
   * **It is also what un-records an optimistic failure**, which is why the route
   * may call `fail` before it knows the answer. `check` is synchronous and `fail`
   * used to run only *after* `await verifyPassword`, so every guess that arrived
   * inside one KDF window saw a counter nothing had incremented yet: measured
   * with a driver, 40 concurrent guesses reached 36 real verifications against a
   * threshold of 5. Recording first and clearing on success closes that window,
   * and it costs nothing a wrong-then-right sequence did not already cost —
   * forgetting the failures on success is this method's whole contract.
   */
  succeed(key: string): void {
    this.entries.delete(normalize(key));
  }

  /**
   * Undo **one** optimistic `fail`, for a key more than one caller spends.
   *
   * ⚠ **Which of these two verbs a key takes is decided by whose key it is, not
   * by how the caller feels about the request.** `succeed` deletes the whole
   * entry, and that is right for `loginKey(name, address)` — one person's own
   * counter, where forgetting five mistypes is the entire contract. It is wrong
   * for any key a *crowd* shares, and `/v1/login` called it on `addressKey` for a
   * release.
   *
   * What that cost: `ADDRESS_THROTTLE` is the only counter that catches a spray
   * across **distinct names**, which a per-identity threshold structurally
   * cannot. `fail` is optimistic, so 29 failed sign-ins naming 29 victims sit
   * just under the threshold, and one successful sign-in to an account the
   * sprayer controls deleted the entry — repeatable for ever from one address.
   * `addressKey` is also spent by `POST /v1/register` and `POST /v1/forgot`,
   * whose own comment states the rule this broke: *recorded before the await and
   * never cleared, because deleting it as an oversight would switch this counter
   * off entirely.* So one sign-in also reset the only bound on account creation
   * from one host.
   *
   * Deleting the call is **not** the fix and was tried on paper: it leaves every
   * successful sign-in's optimistic `fail` standing, so 31 real sign-ins from one
   * office NAT inside the window would 429 the building — exactly the lockout the
   * looser threshold on this counter exists to prevent. Decrementing by one is
   * the shape that keeps both: a success costs the shared bucket nothing, and it
   * erases nobody else's attempt.
   *
   * ⚠ **`blockedUntil` is cleared only once the count is *strictly under* the
   * threshold, and `<=` was not enough.** `fail` arms a block at `failures >
   * threshold`, i.e. at `threshold + 1` — so under `<=` a single forgive walked
   * `threshold + 1` back to `threshold` and cancelled a block that had just been
   * armed. That block is not always the forgiver's own: `/v1/login` pairs its
   * `check` and `fail` synchronously and then awaits `verifyPassword` for ~51ms,
   * which is a wide window on a shared key. With the count at `threshold - 1`, an
   * honest sign-in's `fail` reaches the threshold, a guesser's `fail` arriving
   * inside that await arms the block, and the honest sign-in's `forgive` then lifts
   * it — so the one counter that sees a spray across distinct names was cancellable
   * by the very traffic it is supposed to sit underneath.
   *
   * Strictly-under costs an honest caller nothing they can notice: the block only
   * exists because the crowd went past the threshold, and letting it run its own
   * 30s is the entire point of having counted.
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

  /** For a driver: how many keys are held. */
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

  /**
   * The bound on the table itself.
   *
   * Settled entries go first. If that is not enough the map is cleared outright —
   * which does let somebody flush a real block by sending `maxEntries` distinct
   * names, and that is stated here rather than hidden: it costs them ten thousand
   * requests to buy one reset, so it lowers the wall rather than removing it, and
   * the concurrency gate in `password.ts` bounds the work regardless of how many
   * keys the attempts are spread across. The alternative — an unbounded map keyed
   * by a caller-chosen string — is a worse failure than the one it prevents.
   */
  private enforceCap(now: number): void {
    if (this.entries.size <= this.options.maxEntries) return;
    this.dropSettled(now);
    if (this.entries.size > this.options.maxEntries) this.entries.clear();
  }
}

/**
 * One key per name, case-folded and bounded.
 *
 * Lower-cased because `users.name` is compared exactly but a guesser will not be
 * careful, and a throttle that `Ada` slips past while `ada` is blocked is not a
 * throttle. This is only ever a map key — nothing here decides who anybody is.
 *
 * Private, and it stays private: what a caller composes is a key from the
 * builders below, and a route that could normalize a string of its own would be
 * a second place the composition lives.
 */
function normalize(key: string): string {
  return key.trim().slice(0, MAX_KEY_CHARS).toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Keys
 *
 * Pure, exported, and the only place a key is built. Every one of them is
 * namespaced, including the login key — **not** decoration, and the reason is
 * that the address half is caller-supplied. With a bare `<name>|<address>` a
 * login naming `pwchg` and forwarding `u_deadbeef` writes exactly the key a
 * password change reads, so "an anonymous route cannot block an authenticated
 * one" would have been an argument about `users.name` rather than a property of
 * the string. A fixed first segment containing no separator makes the three
 * spaces disjoint whatever anybody sends.
 * ------------------------------------------------------------------ */

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

/**
 * How much of the name half survives into a key.
 *
 * Bounded here rather than left to `normalize`, which slices the *whole* key:
 * `users.name` is validated at 200 characters, so a composed key built from one
 * would be cut at exactly the point that throws the address away — and every
 * address guessing that name would silently share one counter, which is the
 * bare-name key this file just stopped having. The longest namespace plus both
 * halves plus two separators is 191, comfortably under `MAX_KEY_CHARS`.
 */
const MAX_NAME_KEY_CHARS = 120;

/**
 * The same, for the half of a key that is an email address.
 *
 * Its own constant because it is its own question, and the recipient keys were
 * borrowing `MAX_NAME_KEY_CHARS` — a number derived from `users.name`, sitting
 * under a docblock about login names, applied to a value `address.ts` allows 254
 * characters of. Every address longer than 120 folded into one shared counter,
 * which is the bare-name key this file exists to have stopped having, one value
 * kind along. 254 plus the longest namespace and a separator is 264, still
 * comfortably under `MAX_KEY_CHARS`, so nothing has to be cut at all.
 */
const MAX_EMAIL_KEY_CHARS = 254;

/**
 * One component of a composed key: folded, bounded, and stripped of the
 * separator.
 *
 * The strip is why the halves cannot be re-cut somewhere else: both are chosen
 * by the caller, so without it `a|b` at address `c` and `a` at address `b|c`
 * are one counter.
 */
function field(value: string, max: number): string {
  return normalize(value).slice(0, max).replaceAll(SEPARATOR, "_");
}

/**
 * The key a sign-in attempt is counted against: **who was named, and from
 * where**.
 *
 * The name alone made this a lockout weapon (see the header); the address alone
 * would let one host lock out a shared office by guessing at nobody in
 * particular. Together, a block costs the guesser their own address and costs
 * the named account nothing, which is the only arrangement where a `429` is
 * still an honest answer to "you have been guessing".
 *
 * `address` is whatever `callerAddressOf` answered, including its literal
 * `"unknown"` — a bucket like any other, and the right one for callers nothing
 * can distinguish.
 */
export function loginKey(name: string, address: string): string {
  return [LOGIN_NS, field(name, MAX_NAME_KEY_CHARS), field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * The backstop key: one counter per address, whatever names it named.
 *
 * Used with `ADDRESS_THROTTLE` rather than `DEFAULT_THROTTLE`, because it is the
 * only key a legitimate crowd shares. This is what a spray across distinct names
 * meets — nothing else in this file counts it at all.
 */
export function addressKey(address: string): string {
  return [ADDRESS_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * The key a password change is counted against: the **user id**, never the name.
 *
 * Its own namespace, so no volume of anonymous sign-in attempts can reach it —
 * that sharing was half of the measured lockout. The user id rather than the
 * name because the caller is already authenticated: there is no enumeration
 * question left to answer here, and an id cannot be typed by somebody else.
 */
export function passwordChangeKey(userId: string): string {
  return [PASSWORD_CHANGE_NS, field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}

/**
 * The key a sign-up attempt is counted against: the name asked for, and from
 * where.
 *
 * `loginKey`'s shape, and a separate namespace rather than a reuse of it,
 * because the two count different things: a login failure means "that password
 * was wrong" and a registration failure means "that name is taken". Sharing the
 * space would let somebody probing for free names lock the owner of one out of
 * signing in, which is the lockout `loginKey` was rebuilt to stop.
 *
 * **Registration is also the one route here with no `succeed()`.** It presents
 * no credential, so there is nothing that can turn out to have been right; the
 * optimistic `fail` is left recorded on purpose, which makes the threshold mean
 * *how many accounts one host may create*. Deleting it as an oversight would
 * turn this counter off.
 */
export function registerKey(name: string, address: string): string {
  return [REGISTER_NS, field(name, MAX_NAME_KEY_CHARS), field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * The key that bounds a mail bomb: **the recipient**, not the sender.
 *
 * This is the only counter in the file keyed on somebody who did not make the
 * request, and it is the only one that follows the victim. Every other bound
 * here is keyed on the caller's address, which `net.ts` says is caller-supplied
 * and which a botnet or a forged `x-forwarded-for` rotates for free. An address
 * cannot be rotated: the whole point of the attack is that mail arrives at it.
 *
 * Shared by registration — including the re-send that signing up again performs,
 * which is where the deleted `/v1/register/resend` went — and by an address
 * change, so three messages an hour is three in total rather than three each.
 * **`POST /v1/forgot` is deliberately not among them**: it spends
 * `resetMailKey` under `RESET_MAIL_THROTTLE`, because a budget shared with
 * registration is a budget a stranger can empty, and what it would empty is the
 * only way back into an account.
 *
 * Takes the **folded** address, so a refusal cannot depend on how somebody
 * capitalised their own domain.
 */
export function mailKey(emailFolded: string): string {
  return [MAIL_NS, field(emailFolded, MAX_EMAIL_KEY_CHARS)].join(SEPARATOR);
}

/**
 * Reset mail alone, in its own space, counted under `RESET_MAIL_THROTTLE`.
 *
 * Split out of `mailKey` because sharing one budget let anybody who knew an
 * address spend the recovery channel that address depends on — the reasoning is
 * at `RESET_MAIL_THROTTLE`. Same folded input and same cap, so the two keys
 * differ in exactly one thing: which namespace they live in.
 *
 * Note this is **not** `resetKey`, which is keyed on the *caller's* address and
 * bounds guessing at a link. This one is keyed on the *recipient* and bounds how
 * much reset mail one person can be sent. Two counters, two victims, two names.
 */
export function resetMailKey(emailFolded: string): string {
  return [RESET_MAIL_NS, field(emailFolded, MAX_EMAIL_KEY_CHARS)].join(SEPARATOR);
}

/**
 * Guessing at a confirmation link, per address.
 *
 * Loose on purpose: the token is 32 bytes from the CSPRNG, so this is not what
 * stops it being guessed — arithmetic is. What it stops is somebody discovering
 * *which* tokens are live by spraying, and it costs a legitimate double-tap
 * nothing.
 */
export function confirmKey(address: string): string {
  return [CONFIRM_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/** The same, for a reset link. Its own space so one cannot block the other. */
export function resetKey(address: string): string {
  return [RESET_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * Test messages, per admin.
 *
 * Keyed on the user id like `passwordChangeKey`, and for the same reason: the
 * caller is already authenticated and an admin holding down a button is the
 * likely case rather than an attack.
 */
export function mailTestKey(userId: string): string {
  return [MAIL_TEST_NS, field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}

/**
 * Guessing at an enrollment code, per address.
 *
 * `POST /v1/enroll` was the one route above THE LINE that took a body and
 * counted nothing — every other public route here has a builder. Like
 * `confirmKey` this is not what makes the code unguessable; 256 bits of CSPRNG
 * is. What it bounds is an unauthenticated caller driving one write-lock
 * acquisition per request against the SQLite file the relay shares, and it
 * costs a daemon that redeems its code once at startup nothing at all.
 *
 * Its own namespace rather than `addressKey`'s, so a machine enrolling behind a
 * NAT cannot spend the budget that gates signing in from it.
 */
export function enrollKey(address: string): string {
  return [ENROLL_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * `POST /v1/provision`, which is the other route above THE LINE that carries a
 * credential of its own.
 *
 * Its own namespace for `enrollKey`'s reason, and the bound matters more here:
 * a provisioning key is long-lived and fleet-wide, so guessing it is the attack
 * this counter exists against — where an enrollment code is single-use and lives
 * an hour. An installer provisions once per host, so any threshold a legitimate
 * caller notices is far above what a guesser needs.
 */
export function provisionKey(address: string): string {
  return [PROVISION_NS, field(address, MAX_ADDRESS_CHARS)].join(SEPARATOR);
}

/**
 * An authenticated caller's own budget for the writes that cost something.
 *
 * ⚠ **Everything else in this file counts somebody who is not signed in.** Below
 * THE LINE there were exactly three middlewares — `callerAuth`, `bodyLimit`,
 * `requirePasswordCurrent` — and no counter of any kind, so an ordinary account
 * could drive any route as fast as it could ask. Two of those routes are not
 * free: `POST /v1/machines/:id/enrollments` runs `BEGIN`/`INSERT`/`COMMIT` under
 * `PRAGMA synchronous = FULL`, and `POST /v1/tokens` signs. When this was written
 * that table was also unbounded — this comment said so and nothing acted on it
 * for a release; `pruneEnrollmentCodes` now sweeps it beside the other four, so
 * what is left here is a cost per request rather than a cost that accumulates. `store.ts`
 * justifies that durability setting with "these writes are a handful per
 * administrative action" — which was a statement about how *anybody* would use
 * the service rather than a bound on how anybody could.
 *
 * Keyed on the **user id** and namespaced, like `passwordChangeKey` and
 * `mailTestKey` and for the same two reasons: the caller is already identified,
 * so the address adds nothing and would let a NAT share a budget; and nothing an
 * anonymous caller can write must be able to reach a key an authenticated route
 * reads.
 *
 * `what` separates the routes, so hammering one cannot lock the other. It is a
 * fixed short literal at each call site rather than anything derived from a
 * request — a namespace built from a path would be a namespace a caller chooses.
 */
export function writeKey(userId: string, what: string): string {
  return [WRITE_NS, field(what, MAX_NAME_KEY_CHARS), field(userId, MAX_NAME_KEY_CHARS)].join(SEPARATOR);
}
