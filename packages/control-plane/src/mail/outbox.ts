import type { DatabaseSync } from "node:sqlite";
import { newId } from "../keys.js";
import { mailConfig, type MailConfig } from "../settings.js";
import { foldEmail } from "./address.js";
import { buildMessage } from "./message.js";
import { SMTP_TIMEOUTS, SmtpError, describe, ehloNameFor, sendMessage, type SmtpDialer } from "./smtp.js";

/**
 * Messages waiting to be sent, and the one thing that sends them.
 *
 * ## Why delivery is off the request path
 *
 * The argument is `password.ts`'s, about `scryptSync`, one door along. That file
 * says the synchronous KDF runs once at module load, "before the listener exists
 * and before any tunnel is attached, so there is nothing on the event loop to
 * block", and that everywhere else it would stall the process carrying every
 * relay tunnel in the fleet. An SMTP handshake is the same class of thing and
 * worse: it is one to ninety seconds long, its duration is chosen by a remote
 * host nobody here controls, and a registration burst queues several.
 *
 * Sending inline would hold an HTTP connection open for the length of somebody
 * else's TCP handshake. It would also rebuild the enumeration oracle that
 * answering "the same 200 for a taken address" exists to close: a taken address
 * mails a *notice* and a fresh one mails a *confirmation*, so the two branches
 * would take measurably different times and the identical response body would
 * stop meaning anything.
 *
 * ## The threadpool, which is the non-obvious half
 *
 * `net.connect(host)` resolves the name with `dns.lookup()`, which is
 * `getaddrinfo` **on the libuv threadpool** — the same pool `scrypt` runs on and
 * `serveStatic` draws from. A hung DNS server, or an MX that accepts the
 * connection and never answers, consumes slots. Enough of them and password
 * hashing queues behind DNS, `password.ts` starts answering `503 overloaded`,
 * and the sign-in page — served from the same pool — stops loading. **A mail
 * outage must never become a sign-in outage.** Concurrency of one, hard
 * per-step budgets, and the breaker below are what make that true, and they are
 * the reason this file looks more careful than the volume warrants.
 */

export type MailKind = "register" | "register_notice" | "reset" | "invite" | "verify" | "email_changed" | "test";

/** One message at a time, fleet-wide. A hung server costs exactly one socket. */
const CONCURRENCY = 1;

/**
 * How long a claim is held before the row becomes eligible again.
 *
 * Above `SMTP_TIMEOUTS.total`, so a send that is merely slow is never picked up
 * twice, and finite so a pump that died mid-send leaves a row that recovers
 * rather than one that is stuck for ever.
 */
const LEASE_MS = 120_000;

/**
 * The pump's own ceiling on one `deliver`, above the client's whole-message one.
 *
 * **The lease recovers the row; nothing recovered the pump.** `drain` clears
 * `running` in a `finally`, so a `deliver` that never settles leaves the flag set
 * and every later `wake()`, `enqueue()` and tick returns at the first line for the
 * life of the process — a permanent, silent, fleet-wide mail outage from one
 * stalled socket. `smtp.ts` bounds every step it knows about; this bounds the ones
 * it does not, so the next unbounded await inside the transport costs one message
 * instead of all of them. Above `SMTP_TIMEOUTS.total` so it only ever fires when
 * that ceiling has already failed to.
 */
const DELIVER_WATCHDOG_MS = SMTP_TIMEOUTS.total + 15_000;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * The most unsent messages this will hold.
 *
 * Past it, enqueue refuses and the route answers `503 overloaded` with a
 * `Retry-After`. `relay/proxy.ts`'s rule, restated: a tunnel with no daemon is a
 * 503 and never a queue, because holding work turns an outage into a memory leak
 * during the incident it is supposed to survive.
 */
export const MAX_OUTBOX_PENDING = 500;

/** Terminal rows are kept this long so "did it go out" stays answerable. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fail every unsent row whose deadline has passed, and drop its body with it.
 *
 * Set-based and claim-free on purpose: this has to run on a pump that cannot
 * dial, which is exactly the state that produced rows nothing would ever look at
 * again. Exported so a driver can drive it without a dialer.
 */
export function expireStaleMail(db: DatabaseSync, now = Date.now()): number {
  const changed = db
    .prepare(
      "UPDATE mail_outbox SET failed_at = ?, last_error = 'expired before delivery', body = NULL " +
        "WHERE sent_at IS NULL AND failed_at IS NULL AND not_after <= ?",
    )
    .run(now, now);
  return Number(changed.changes);
}

/**
 * How many consecutive failures stop this dialling, and for how long.
 *
 * A mail server that is down does not become up because we asked eight more
 * times, and every attempt costs a threadpool slot and up to ninety seconds. The
 * breaker is what turns "mail is broken" into a degraded feature rather than a
 * degraded service.
 */
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

export interface EnqueueArgs {
  to: string;
  kind: MailKind;
  subject: string;
  text: string;
  html: string;
  /**
   * When this message stops being worth sending — the expiry of whatever token
   * it carries. Past it the pump fails the row **without dialling**, which is
   * how a reset that expires in an hour stops being retried for four.
   */
  notAfter: number;
}

export interface OutboxRow {
  id: string;
  to: string;
  kind: string;
  subject: string;
  body: string;
  notAfter: number;
  attempts: number;
}

/**
 * What `app.ts` is handed.
 *
 * An interface rather than the pump itself, exactly as `ControlPlaneOptions.relay`
 * already is: `relaycheck` passes a recording fake and asserts that a mailer
 * which never resolves cannot change a route's status or its timing, which is
 * the only property about mail that an offline driver can reach at all.
 */
export interface MailSender {
  /** Returns the row id, or `null` when the queue is full. */
  enqueue(args: EnqueueArgs, now?: number): string | null;
  /** Ask the pump to look now rather than on its next tick. */
  wake(): void;
  /**
   * Whether the breaker is open, when the sender has one.
   *
   * Optional here and required on `MailPump`, which is the only implementation
   * that can have a breaker at all — a driver's fake sender has nothing to trip.
   * On this interface because `app.ts` takes a `MailSender` and is the thing that
   * has to report it: the breaker was in-memory, unread by anything but its own
   * module, and therefore invisible on the one screen an admin configures mail
   * from.
   */
  paused?(): boolean;
}

/**
 * What an admin needs in order to know mail is broken.
 *
 * ⚠ **Nothing surfaced any of this, and the gap was total.** `send()` in `app.ts`
 * returns whether a *row was inserted*, the UI turns that into "Invitation queued
 * for …", and a permanent SMTP failure after that point reaches exactly one
 * place: `console.error`, inside a container whose logs are capped at 10 MiB × 5.
 * The delivery log was deliberately removed from the web UI as noise and
 * `cpctl admin mail` is the answer for somebody who already suspects a problem —
 * which leaves nothing at all to *raise* the suspicion. An invitation is 48h and
 * an invited account holds no password and an unverified address, so `/v1/forgot`
 * mails nothing: the first user's door closes silently and the admin has no
 * reason to look.
 *
 * Counts and one sentence, deliberately — not the log. The question this answers
 * is "is mail working", which is a banner; "where did message X go" is still
 * `cpctl admin mail`.
 *
 * `lastError` is already truncated and CR/LF-stripped where it is written
 * (`recordMailFailed`), because it is remote text from an admin-supplied host.
 */
export interface MailDeliveryHealth {
  /** Queued, not yet sent, not yet failed, not yet past its deadline. */
  pending: number;
  /** Terminal failures still inside `RETENTION_MS`. */
  failed: number;
  /** How long the oldest pending message has been waiting, or `null` for none. */
  oldestPendingMs: number | null;
  /** The most recent failure's own words, or `null`. */
  lastError: string | null;
  /** When that failure was recorded. */
  lastFailedAt: number | null;
}

export function mailHealth(db: DatabaseSync, now = Date.now()): MailDeliveryHealth {
  const pending = db
    .prepare(
      "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM mail_outbox " +
        "WHERE sent_at IS NULL AND failed_at IS NULL AND not_after > ?",
    )
    .get(now);
  const failed = db
    .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE failed_at IS NOT NULL")
    .get();
  const last = db
    .prepare(
      "SELECT failed_at, last_error FROM mail_outbox WHERE failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT 1",
    )
    .get();
  const oldest = pending?.["oldest"];
  return {
    pending: Number(pending?.["n"] ?? 0),
    failed: Number(failed?.["n"] ?? 0),
    oldestPendingMs: oldest == null ? null : Math.max(0, now - Number(oldest)),
    lastError: last?.["last_error"] == null ? null : String(last["last_error"]),
    lastFailedAt: last?.["failed_at"] == null ? null : Number(last["failed_at"]),
  };
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

export function pendingCount(db: DatabaseSync, now = Date.now()): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND not_after > ?")
    .get(now);
  return Number(row?.["n"] ?? 0);
}

/**
 * Put a rendered message on the queue.
 *
 * The body is rendered by the caller and stored whole, which is what makes this
 * synchronous and what keeps the pump ignorant of what it is carrying. It is
 * also, deliberately said out loud here and in `schema.sql`, **a live credential
 * while it sits in the row**: it holds the one-time link. `recordMailSent`
 * clears it in the same statement that marks the row sent, and `not_after`
 * bounds it on the failure path.
 */
export function enqueueMail(db: DatabaseSync, args: EnqueueArgs, now = Date.now()): string | null {
  if (pendingCount(db, now) >= MAX_OUTBOX_PENDING) return null;

  const id = newId("mo");
  db.prepare(
    "INSERT INTO mail_outbox (id, to_address, to_folded, kind, subject, body, created_at, not_after, next_at, attempts) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(id, args.to, foldEmail(args.to), args.kind, args.subject, renderStored(args), now, args.notAfter, now);
  return id;
}

/** The two parts, stored together so the pump needs no template. */
function renderStored(args: EnqueueArgs): string {
  return JSON.stringify({ text: args.text, html: args.html });
}

function readStored(body: string): { text: string; html: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      return { text: String(record["text"] ?? ""), html: String(record["html"] ?? "") };
    }
  } catch {
    // A body we cannot parse is a row from a future or a corrupted one. Sending
    // it as plain text is better than failing it: the link is in the text.
  }
  return { text: body, html: body };
}

/**
 * How long a `register_notice` speaks for the address it went to.
 *
 * Beside `sentRecently` rather than in `app.ts`, because the interval and the
 * query that enforces it are one decision — and because the rule went a whole
 * change with the function written, the index created and three docblocks
 * describing it, and no call site.
 */
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether this address has already been told something of this kind recently.
 *
 * Exists for one rule: at most one "somebody tried to sign up with your address"
 * per address per day. That message goes to a third party on an anonymous
 * request, so it is the vector the "a taken address answers the same 200"
 * decision creates, and this is its bound.
 *
 * Asked against the **outbox** rather than a counter in memory, which is what
 * makes the bound survive a restart — the throttles beside it do not, and for a
 * message aimed at somebody who is not the caller that difference is the point.
 */
export function sentRecently(
  db: DatabaseSync,
  toFolded: string,
  kind: MailKind,
  withinMs: number,
  now = Date.now(),
): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM mail_outbox WHERE to_folded = ? AND kind = ? AND created_at > ? LIMIT 1")
    .get(toFolded, kind, now - withinMs);
  return row !== undefined;
}

/**
 * Take the next message, atomically.
 *
 * A conditional `UPDATE` followed by `changes === 1`, which is
 * `enrollment_codes`' single-use template applied to a work queue. There is one
 * pump today — but the second pump is two containers started against one volume
 * by accident, and that is precisely the moment a duplicate password-reset link
 * goes out. Writing the lease into `next_at` rather than a `claimed_at` column
 * means a pump that crashed mid-send leaves a row that becomes eligible again
 * instead of one that needs a second sweep to unstick.
 */
export function claimNextMail(db: DatabaseSync, now = Date.now(), leaseMs = LEASE_MS): OutboxRow | null {
  const candidate = db
    .prepare(
      "SELECT id FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= ? " +
        "ORDER BY next_at, created_at LIMIT 1",
    )
    .get(now);
  if (candidate === undefined) return null;

  const id = String(candidate["id"]);
  const claimed = db
    .prepare(
      "UPDATE mail_outbox SET attempts = attempts + 1, next_at = ? " +
        "WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL AND next_at <= ?",
    )
    .run(now + leaseMs, id, now);
  if (Number(claimed.changes) !== 1) return null;

  const row = db
    .prepare("SELECT id, to_address, kind, subject, body, not_after, attempts FROM mail_outbox WHERE id = ?")
    .get(id);
  if (row === undefined) return null;
  return {
    id,
    to: String(row["to_address"]),
    kind: String(row["kind"]),
    subject: String(row["subject"]),
    body: String(row["body"] ?? ""),
    notAfter: Number(row["not_after"]),
    attempts: Number(row["attempts"]),
  };
}

/**
 * Mark it delivered, and drop the secret in the same statement.
 *
 * One statement rather than two, so there is no window in which a row is both
 * "sent" and still carrying a working link — and no path on which the second
 * write is skipped by an early return somebody adds later.
 */
export function recordMailSent(db: DatabaseSync, id: string, now = Date.now()): void {
  db.prepare("UPDATE mail_outbox SET sent_at = ?, body = NULL, last_error = NULL WHERE id = ?").run(now, id);
}

/** Full jitter, from an injected source so a driver can walk the curve. */
export function backoffMs(attempts: number, random: () => number): number {
  const flat = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(flat * (0.8 + random() * 0.4));
}

export function recordMailFailure(
  db: DatabaseSync,
  row: OutboxRow,
  error: unknown,
  now = Date.now(),
  random: () => number = Math.random,
): void {
  const smtp = error instanceof SmtpError ? error : null;
  const text = smtp === null ? describe(error) : `${smtp.step}: ${smtp.message}`;
  // A permanent refusal is not retried: 5xx means this message will be refused
  // the same way in an hour, and eight of those is eight minutes of somebody
  // else's server telling us the same thing.
  const giveUp = row.attempts >= MAX_ATTEMPTS || smtp?.permanent === true;
  if (giveUp) {
    /*
     * **`body = NULL` here too, and forgetting it was the leak.** The column
     * holds a rendered message including its one-time link — the only plaintext
     * credential in this database beside the fleet signing key — and the schema
     * says it is "kept on failure only until `not_after`". A row that gives up
     * never reaches the `not_after` branch: `claimNextMail` filters on
     * `failed_at IS NULL`, so nothing looks at it again, and `pruneMailOutbox`
     * only removes it once `RETENTION_MS` has passed. That is seven days of a
     * live-shaped credential kept for an operator who can read `last_error`
     * without it.
     */
    db.prepare("UPDATE mail_outbox SET failed_at = ?, last_error = ?, body = NULL WHERE id = ?").run(
      now,
      text,
      row.id,
    );
    return;
  }
  db.prepare("UPDATE mail_outbox SET next_at = ?, last_error = ? WHERE id = ?").run(
    now + backoffMs(row.attempts, random),
    text,
    row.id,
  );
}

export function pruneMailOutbox(db: DatabaseSync, now = Date.now()): number {
  const changed = db
    .prepare("DELETE FROM mail_outbox WHERE (sent_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at < ?")
    .run(now - RETENTION_MS);
  /*
   * **The second arm is for rows that never reached a terminal state at all.**
   * `drain` returns before claiming anything while `mailConfig` is null, so a
   * message queued when SMTP worked and orphaned when an admin cleared a setting
   * is never claimed, never expired and never failed — and the arm above only
   * ever removes rows that are one of those. It kept its `body`, i.e. its
   * one-time link, for the life of the volume, and `pendingCount` filters on
   * `not_after > ?` so it did not even count against `MAX_OUTBOX_PENDING`.
   *
   * Bounded by `not_after` plus the same retention, so a row is still readable
   * for the week after it expired — the window in which somebody asks why their
   * mail never arrived.
   */
  const stalled = db
    .prepare(
      "DELETE FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND not_after < ?",
    )
    .run(now - RETENTION_MS);
  return Number(changed.changes) + Number(stalled.changes);
}

/* ------------------------------------------------------------------ *
 * The pump
 * ------------------------------------------------------------------ */

export type MailEvent = "sent" | "failed" | "unconfigured" | "expired" | "breaker_open" | "breaker_closed";

export interface MailPump extends MailSender {
  stop(): void;
  /** Exposed so the startup banner and a driver can see the breaker. */
  paused(): boolean;
}

export interface PumpOptions {
  db: DatabaseSync;
  dialer: SmtpDialer;
  /**
   * Where words go. Nothing in this package prints — `main.ts` is the entry
   * point and does — so this is `TunnelRegistry`'s shape: the pump reports, the
   * process decides what that looks like.
   */
  onEvent?: (event: MailEvent, detail: string) => void;
  random?: () => number;
  now?: () => number;
  /** How often to look when nothing has woken it. */
  tickMs?: number;
}

export function startMailPump(options: PumpOptions): MailPump {
  const { db, dialer } = options;
  const onEvent = options.onEvent ?? ((): void => {});
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 15_000;

  let running = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let pausedUntil = 0;

  const timer = setInterval(() => void drain(), tickMs);
  // The only timer here, and it is unref'd on purpose: an idle mail queue must
  // not be the reason a process refuses to exit. Anything actually in flight is
  // held by its own socket.
  timer.unref?.();

  async function drain(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      for (let sent = 0; sent < CONCURRENCY * 32; sent += 1) {
        const at = now();
        if (stopped) return;
        if (at < pausedUntil) return;

        /*
         * **Expiry is a property of the queue, not of the SMTP client**, so it
         * runs above the configuration check rather than below it. Underneath,
         * a message queued while mail worked and orphaned when an admin cleared
         * a setting was never claimed, never expired and never failed — it kept
         * its rendered body, and its one-time link, indefinitely.
         */
        expireStaleMail(db, at);

        const config = mailConfig(db);
        if (config === null) {
          // Nothing is wrong with the queue; this instance simply cannot send
          // yet. Rows wait rather than fail, because the operator finishing the
          // settings form is the ordinary next event.
          return;
        }

        const row = claimNextMail(db, at);
        if (row === null) return;

        if (row.notAfter <= at) {
          db.prepare("UPDATE mail_outbox SET failed_at = ?, last_error = ?, body = NULL WHERE id = ?").run(
            at,
            "expired before delivery",
            row.id,
          );
          onEvent("expired", `${row.kind} to ${row.to}`);
          continue;
        }

        try {
          /*
           * The watchdog is the pump's own, and it is deliberately redundant
           * with every ceiling inside `smtp.ts`. See `DELIVER_WATCHDOG_MS`: what
           * it protects is not this message but the *next* one, because the flag
           * this loop clears in its `finally` is the only thing standing between
           * one wedged socket and a fleet that never sends mail again.
           */
          await watchdog(deliver(config, row));
          recordMailSent(db, row.id, now());
          if (consecutiveFailures >= BREAKER_THRESHOLD) onEvent("breaker_closed", "mail is working again");
          consecutiveFailures = 0;
          onEvent("sent", `${row.kind} to ${row.to}`);
        } catch (error) {
          recordMailFailure(db, row, error, now(), random);
          consecutiveFailures += 1;
          onEvent("failed", `${row.kind} to ${row.to}: ${describe(error)}`);
          if (consecutiveFailures >= BREAKER_THRESHOLD) {
            pausedUntil = now() + BREAKER_COOLDOWN_MS;
            onEvent(
              "breaker_open",
              `${consecutiveFailures} sends failed in a row — pausing for ${Math.round(BREAKER_COOLDOWN_MS / 60_000)} minutes`,
            );
            return;
          }
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * The pump's last line of defence against an await that never settles.
   *
   * Rejecting frees `running` through the loop's `finally`, which is the whole
   * point — the message is lost to a retry, the pump is not. The abandoned work
   * keeps whatever socket it holds; `smtp.ts` is where that is bounded, and this
   * exists precisely for the case where it was not.
   */
  async function watchdog<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the mailer did not settle within ${DELIVER_WATCHDOG_MS}ms`)),
            DELIVER_WATCHDOG_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(config: MailConfig, row: OutboxRow): Promise<void> {
    const parts = readStored(row.body);
    const message = buildMessage({
      from: { address: config.from, name: config.fromName },
      to: row.to,
      replyTo: config.replyTo,
      subject: row.subject,
      text: parts.text,
      html: parts.html,
      date: new Date(now()),
      boundary: newId("b").replace("b_", "reemoat-"),
      messageId: newId("m").replace("m_", ""),
    });

    await sendMessage(
      {
        host: config.host,
        port: config.port,
        security: config.security,
        auth: config.auth,
        username: config.username,
        password: config.password,
        rejectUnauthorized: config.rejectUnauthorized,
        ehloName: ehloNameFor(config.publicUrl),
        dialer,
      },
      { from: config.from, to: row.to, message },
    );
  }

  /*
   * **The kick is deferred a tick, and that is about the request, not the mail.**
   * `drain` runs synchronously as far as its first await — the settings reads,
   * the claim, the whole MIME render, and then `net.connect`, whose `dns.lookup`
   * takes a libuv slot. Called straight from `enqueue`, all of that happened
   * inside the HTTP handler, on the branch that mails and not on the branch that
   * does not: `POST /v1/forgot` promises the two are indistinguishable, and the
   * difference was measurable. `setImmediate` puts every branch back on the same
   * footing and costs one tick of latency nobody is waiting on.
   */
  const kick = (): void => {
    setImmediate(() => void drain());
  };

  return {
    enqueue(args: EnqueueArgs, at = now()): string | null {
      const id = enqueueMail(db, args, at);
      if (id !== null) kick();
      return id;
    },
    wake(): void {
      kick();
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    paused(): boolean {
      return now() < pausedUntil;
    },
  };
}


