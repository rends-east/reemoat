import type { DatabaseSync } from "node:sqlite";
import { newId } from "../keys.js";
import { mailConfig, type MailConfig } from "../settings.js";
import { foldEmail } from "./address.js";
import { buildMessage } from "./message.js";
import {
  SMTP_TIMEOUTS,
  SmtpError,
  describe,
  ehloNameFor,
  sanitizeReply,
  sendMessage,
  type SmtpDialer,
} from "./smtp.js";

// Delivery is off the request path, one message at a time under hard budgets: DNS shares the libuv pool with scrypt,
// and a mail outage must never become a sign-in outage.

export type MailKind = "register" | "register_notice" | "reset" | "invite" | "verify" | "email_changed" | "test";

/** One message at a time, fleet-wide. A hung server costs exactly one socket. */
const CONCURRENCY = 1;

/** Above SMTP_TIMEOUTS.total so a slow send is never claimed twice; finite so a row a dead pump held recovers. */
const LEASE_MS = 120_000;

/** Bounds deliver itself: a deliver that never settles would leave the pump's running flag set for the life of the process. */
const DELIVER_WATCHDOG_MS = SMTP_TIMEOUTS.total + 15_000;

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Past this, enqueue refuses (the route answers 503) rather than letting the queue grow through an outage. */
export const MAX_OUTBOX_PENDING = 500;

/** Kinds a caller can produce on demand; reset and invite are left out so recovery stays reachable. */
const CALLER_DRIVEN: ReadonlySet<MailKind> = new Set<MailKind>([
  "register",
  "register_notice",
  "verify",
  "email_changed",
  "test",
]);

/** Caps the caller-driven kinds, so filling the queue with them cannot lock anybody out of a password reset. */
export const MAX_OUTBOX_CALLER_DRIVEN = 400;

/** Advisory: /v1/forgot asks before minting burns the previous reset link, and enqueueMail re-checks. */
export function mailAccepts(db: DatabaseSync, kind: MailKind, now = Date.now()): boolean {
  if (pendingCount(db, now) >= MAX_OUTBOX_PENDING) return false;
  if (!CALLER_DRIVEN.has(kind)) return true;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mail_outbox " +
        "WHERE sent_at IS NULL AND failed_at IS NULL AND not_after > ? " +
        `AND kind IN (${[...CALLER_DRIVEN].map(() => "?").join(", ")})`,
    )
    .get(now, ...CALLER_DRIVEN);
  return Number(row?.["n"] ?? 0) < MAX_OUTBOX_CALLER_DRIVEN;
}

/** Terminal rows are kept this long so "did it go out" stays answerable. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Set-based and claim-free, so it runs even on a pump that cannot dial. */
export function expireStaleMail(db: DatabaseSync, now = Date.now()): number {
  const changed = db
    .prepare(
      "UPDATE mail_outbox SET failed_at = ?, last_error = 'expired before delivery', body = NULL " +
        "WHERE sent_at IS NULL AND failed_at IS NULL AND not_after <= ?",
    )
    .run(now, now);
  return Number(changed.changes);
}

const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

export interface EnqueueArgs {
  to: string;
  kind: MailKind;
  subject: string;
  text: string;
  html: string;
  /** Past this the row fails without dialling: the expiry of the token the message carries. */
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

export interface MailSender {
  /** Returns the row id, or `null` when the queue is full. */
  enqueue(args: EnqueueArgs, now?: number): string | null;
  wake(): void;
  paused?(): boolean;
}

/** Counts and the latest failure, for an admin banner; where one message went is still cpctl admin mail. */
export interface MailDeliveryHealth {
  pending: number;
  failed: number;
  oldestPendingMs: number | null;
  lastError: string | null;
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

export function pendingCount(db: DatabaseSync, now = Date.now()): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND not_after > ?")
    .get(now);
  return Number(row?.["n"] ?? 0);
}

/** The stored body holds the one-time link: a live credential until recordMailSent clears it, bounded by not_after on failure. */
export function enqueueMail(db: DatabaseSync, args: EnqueueArgs, now = Date.now()): string | null {
  if (!mailAccepts(db, args.kind, now)) return null;

  const id = newId("mo");
  db.prepare(
    "INSERT INTO mail_outbox (id, to_address, to_folded, kind, subject, body, created_at, not_after, next_at, attempts) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(id, args.to, foldEmail(args.to), args.kind, args.subject, renderStored(args), now, args.notAfter, now);
  return id;
}

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
    // An unparseable body is sent as plain text: the link is in the text.
  }
  return { text: body, html: body };
}

export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** At most one sign-up notice per address per day, asked of the outbox so the bound survives a restart. */
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

/** Conditional UPDATE, so two pumps on one volume never send one message twice; the lease in next_at lets a crashed send recover. */
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

/** One statement, so no row is ever both sent and still carrying a working link. */
export function recordMailSent(db: DatabaseSync, id: string, now = Date.now()): void {
  db.prepare("UPDATE mail_outbox SET sent_at = ?, body = NULL, last_error = NULL WHERE id = ?").run(now, id);
}

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
  // Sanitized whole: TLS and socket text is not a server reply, and reaches the admin banner just the same.
  const text = sanitizeReply(smtp === null ? describe(error) : `${smtp.step}: ${smtp.message}`);
  // A permanent (5xx) refusal is not retried.
  const giveUp = row.attempts >= MAX_ATTEMPTS || smtp?.permanent === true;
  if (giveUp) {
    // Clear the body here too: a failed row is never claimed again and would keep its one-time link until pruned.
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
  // Second arm: rows never claimed or failed are removed a retention period after not_after.
  const stalled = db
    .prepare(
      "DELETE FROM mail_outbox WHERE sent_at IS NULL AND failed_at IS NULL AND not_after < ?",
    )
    .run(now - RETENTION_MS);
  return Number(changed.changes) + Number(stalled.changes);
}

export type MailEvent = "sent" | "failed" | "unconfigured" | "expired" | "breaker_open" | "breaker_closed";

export interface MailPump extends MailSender {
  stop(): void;
  paused(): boolean;
}

export interface PumpOptions {
  db: DatabaseSync;
  dialer: SmtpDialer;
  onEvent?: (event: MailEvent, detail: string) => void;
  random?: () => number;
  now?: () => number;
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
  // unref'd: an idle mail queue must not keep the process alive.
  timer.unref?.();

  async function drain(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      for (let sent = 0; sent < CONCURRENCY * 32; sent += 1) {
        const at = now();
        if (stopped) return;
        if (at < pausedUntil) return;

        // Expiry runs before the configuration check, so rows orphaned by a cleared setting still expire.
        expireStaleMail(db, at);

        const config = mailConfig(db);
        if (config === null) {
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

  // Deferred a tick, so the POST /v1/forgot branch that mails costs the handler the same as the one that does not.
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


