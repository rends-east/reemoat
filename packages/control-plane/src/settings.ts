import type { DatabaseSync } from "node:sqlite";
import { checkEmailAddress } from "./mail/address.js";
import { MAX_MACHINES_PER_USER } from "./machines.js";

// An instance_settings row wins, else the environment, else unset. Read live with no cache; nothing seeds the table, since schema.sql re-runs on every open.

export const SETTING_KEYS = [
  // First and apart from registration.*: the admin screen reads a run of one prefix as a section.
  "machines.per_user",
  "registration.enabled",
  "registration.email_domains",
  "mail.from",
  "mail.from_name",
  "mail.reply_to",
  "mail.public_url",
  "smtp.host",
  "smtp.port",
  "smtp.security",
  "smtp.username",
  "smtp.password",
  "smtp.auth",
  "smtp.tls_reject_unauthorized",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const SECRET_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(["smtp.password"]);

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

export function envNameFor(key: SettingKey): string {
  return `REEMOAT_CP_${key.replace(/\./g, "_").toUpperCase()}`;
}

export type SettingSource = "database" | "environment" | "unset";

export interface Resolved {
  value: string | null;
  source: SettingSource;
}

interface SettingStatements {
  read: ReturnType<DatabaseSync["prepare"]>;
  all: ReturnType<DatabaseSync["prepare"]>;
  write: ReturnType<DatabaseSync["prepare"]>;
  clear: ReturnType<DatabaseSync["prepare"]>;
}

const settingStatements = new WeakMap<DatabaseSync, SettingStatements>();

function statements(db: DatabaseSync): SettingStatements {
  let held = settingStatements.get(db);
  if (held === undefined) {
    held = {
      read: db.prepare("SELECT value FROM instance_settings WHERE key = ?"),
      all: db.prepare("SELECT key, value FROM instance_settings"),
      write: db.prepare(
        "INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, " +
          "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      ),
      clear: db.prepare("DELETE FROM instance_settings WHERE key = ?"),
    };
    settingStatements.set(db, held);
  }
  return held;
}

/** A row wins even when its value is empty; an empty environment variable counts as unset. */
export function readSetting(db: DatabaseSync, key: SettingKey): Resolved {
  const row = statements(db).read.get(key);
  if (row !== undefined) return { value: String(row["value"]), source: "database" };
  const fromEnv = (process.env[envNameFor(key)] ?? "").trim();
  if (fromEnv.length > 0) return { value: fromEnv, source: "environment" };
  return { value: null, source: "unset" };
}

export function readString(db: DatabaseSync, key: SettingKey, fallback: string | null = null): string | null {
  return readSetting(db, key).value ?? fallback;
}

export function readBoolean(db: DatabaseSync, key: SettingKey, fallback: boolean): boolean {
  const raw = readSetting(db, key).value;
  if (raw === null) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

export function readPort(db: DatabaseSync, key: SettingKey, fallback: number): number {
  const raw = readSetting(db, key).value;
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

/** Falls back on anything out of range: a bad stored value must not throw on a per-request path. */
export function readInteger(
  db: DatabaseSync,
  key: SettingKey,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readSetting(db, key).value;
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function readEnum<T extends string>(
  db: DatabaseSync,
  key: SettingKey,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readSetting(db, key).value;
  if (raw === null) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export function writeSetting(
  db: DatabaseSync,
  key: SettingKey,
  value: string,
  updatedBy: string | null,
  now = Date.now(),
): void {
  statements(db).write.run(key, value, now, updatedBy);
}

export function clearSetting(db: DatabaseSync, key: SettingKey): boolean {
  return Number(statements(db).clear.run(key).changes) === 1;
}

export const SMTP_SECURITIES = ["implicit_tls", "starttls", "plaintext"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

export const SMTP_AUTHS = ["plain", "login", "none"] as const;
export type SmtpAuth = (typeof SMTP_AUTHS)[number];

/** The refusal sentence, or `null`. Values are strings only, so a GET answers exactly what was PUT. */
export function checkSettingValue(key: SettingKey, value: string): string | null {
  if (value.length > 2048) return `${key} is too long`;
  // Control characters in any of these end up in an SMTP header or a shell-read
  // environment file. Refused here rather than at each use.
  if (/[\x00-\x1f\x7f]/.test(value)) return `${key} may not contain control characters`;

  switch (key) {
    // 0 must pass (nobody gets a machine until an admin grants one); the String comparison refuses trailing text parseInt accepts.
    case "machines.per_user": {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) &&
        String(parsed) === value.trim() &&
        parsed >= 0 &&
        parsed <= MAX_MACHINES_PER_USER
        ? null
        : `machines.per_user must be a whole number between 0 and ${MAX_MACHINES_PER_USER}`;
    }
    case "registration.enabled":
      return value === "true" || value === "false" ? null : "registration.enabled must be 'true' or 'false'";
    case "smtp.tls_reject_unauthorized":
      return value === "true" || value === "false"
        ? null
        : "smtp.tls_reject_unauthorized must be 'true' or 'false'";
    case "smtp.port": {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
        ? null
        : "smtp.port must be a number between 1 and 65535";
    }
    case "smtp.security":
      return (SMTP_SECURITIES as readonly string[]).includes(value)
        ? null
        : `smtp.security must be one of ${SMTP_SECURITIES.join(", ")}`;
    case "smtp.auth":
      return (SMTP_AUTHS as readonly string[]).includes(value)
        ? null
        : `smtp.auth must be one of ${SMTP_AUTHS.join(", ")}`;
    case "mail.public_url": {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return "mail.public_url must be an absolute URL";
      }
      // Checked here rather than relied on from `new URL`, which accepts every
      // scheme. This value becomes the origin of a link in an email.
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? null
        : "mail.public_url must be http or https";
    }
    // Checked here because nothing else checks an address that arrives as a setting; empty passes, and mailConfigured reports a missing mail.from.
    case "mail.from":
    case "mail.reply_to": {
      if (value === "") return null;
      const checked = checkEmailAddress(value);
      return checked.ok ? null : `${key}: ${checked.message}`;
    }
    // Free text, listed rather than a default arm so a key added to SETTING_KEYS fails to compile here.
    case "registration.email_domains":
    case "mail.from_name":
    case "smtp.host":
    case "smtp.username":
    case "smtp.password":
      return null;
  }
}

export interface MailConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  auth: SmtpAuth;
  username: string | null;
  password: string | null;
  rejectUnauthorized: boolean;
  from: string;
  fromName: string | null;
  replyTo: string | null;
  publicUrl: string;
}

/** 587, not 25: port 25 outbound is blocked by most clouds and hangs rather than refusing. */
export const DEFAULT_SMTP_PORT = 587;

/** `problems` are sentences for the admin screen; only the missing settings make `configured` false. */
export function mailConfigured(
  db: DatabaseSync,
  /** The request's API origin, passed only while this process serves no gate bundle; absent produces no origin warning. */
  apiOriginServingNoGate?: string | null,
): { configured: boolean; problems: string[] } {
  const problems: string[] = [];
  if (readString(db, "smtp.host") === null) problems.push("smtp.host is not set");
  if (readString(db, "mail.from") === null) problems.push("mail.from is not set");
  if (readString(db, "mail.public_url") === null) {
    problems.push("mail.public_url is not set, so links in messages would have nowhere to point");
  }

  // Without this, sendMessage skips AUTH and every message dies at 530; smtp.auth none is how to say a server wants no credential.
  const auth = readEnum<SmtpAuth>(db, "smtp.auth", SMTP_AUTHS, "plain");
  if (auth !== "none") {
    if (!usable(readString(db, "smtp.username"))) {
      problems.push("smtp.username is not set — most servers want the full mailbox address");
    }
    if (!usable(readString(db, "smtp.password"))) problems.push("smtp.password is not set");
  }

  // A warning, not a refusal: a relay authorising a whole domain may legitimately send as any address in it.
  const username = readString(db, "smtp.username");
  const from = readString(db, "mail.from");
  if (
    auth !== "none" &&
    username !== null &&
    from !== null &&
    username.includes("@") &&
    username.toLowerCase() !== from.toLowerCase()
  ) {
    problems.push(
      `mail.from (${from}) is not the mailbox you sign in as (${username}) — ` +
        "many providers refuse that unless it is an alias of it",
    );
  }

  // A warning, never a refusal: the sentence must not contain the phrase isMissing matches, or it would stop all mail.
  const publicUrl = readString(db, "mail.public_url");
  if (apiOriginServingNoGate !== null && apiOriginServingNoGate !== undefined && publicUrl !== null) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(publicUrl).origin === new URL(apiOriginServingNoGate).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) {
      problems.push(
        `mail.public_url (${publicUrl}) points at this control plane, which is running without its gate ` +
          "bundle — links in messages answer an error rather than a page. Build it with " +
          "pnpm --filter @reemoat/web build:gate, or point mail.public_url at wherever the gate is served",
      );
    }
  }

  return { configured: !problems.some(isMissing), problems };
}

function isMissing(problem: string): boolean {
  return problem.includes("is not set");
}

/** An empty credential is a malformed sign-in, not an absent one; smtp.auth none says a server wants none. */
function usable(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

export function mailConfig(db: DatabaseSync): MailConfig | null {
  if (!mailConfigured(db).configured) return null;
  const security = readEnum<SmtpSecurity>(db, "smtp.security", SMTP_SECURITIES, "starttls");
  return {
    host: readString(db, "smtp.host") ?? "",
    port: readPort(db, "smtp.port", DEFAULT_SMTP_PORT),
    security,
    auth: readEnum<SmtpAuth>(db, "smtp.auth", SMTP_AUTHS, "plain"),
    // Same predicate as mailConfigured, so an empty credential becomes null and AUTH is skipped rather than sent malformed.
    username: usable(readString(db, "smtp.username")) ? readString(db, "smtp.username") : null,
    password: usable(readString(db, "smtp.password")) ? readString(db, "smtp.password") : null,
    rejectUnauthorized: readBoolean(db, "smtp.tls_reject_unauthorized", true),
    from: readString(db, "mail.from") ?? "",
    fromName: readString(db, "mail.from_name"),
    replyTo: readString(db, "mail.reply_to"),
    publicUrl: (readString(db, "mail.public_url") ?? "").replace(/\/+$/, ""),
  };
}

export interface RegistrationMode {
  enabled: boolean;
  requiresEmail: boolean;
}

export function registrationMode(db: DatabaseSync): RegistrationMode {
  return {
    enabled: readBoolean(db, "registration.enabled", false),
    requiresEmail: mailConfigured(db).configured,
  };
}

export function parseEmailDomains(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^@/, "").toLowerCase())
    .filter((part) => part.length > 0);
}

export function emailDomainAllowed(emailFolded: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const at = emailFolded.lastIndexOf("@");
  if (at < 0) return false;
  const domain = emailFolded.slice(at + 1);
  return domains.includes(domain);
}
