import type { DatabaseSync } from "node:sqlite";
import { checkEmailAddress } from "./mail/address.js";
import { MAX_MACHINES_PER_USER } from "./machines.js";

/**
 * Settings an admin may change at runtime, and the environment underneath them.
 *
 * **The rule is one line: a row in `instance_settings` wins, the environment is
 * the fallback, and absence of both is `unset`.** That is why the table is
 * key/value — the absence of a row *is* "read the environment", so the storage
 * shape and the fallback rule are the same sentence rather than two mechanisms
 * that have to agree.
 *
 * Everything here reads live. **There is no cache**, and that is deliberate
 * rather than lazy: a cache needs an invalidation path, and this repository has
 * already paid for exactly that mistake once — `app.ts`'s SPA fallback held a
 * copy of `index.html` taken at registration, `pnpm web:build` rewrote `dist/`
 * under the running process, and `/` served the new HTML while every deep link
 * served chunks Vite had deleted. Reloading on a session gave a blank page with
 * no error. A settings read is one indexed probe on a table with a dozen rows,
 * the same cost `GET /v1/me` already pays for `hasPassword`.
 *
 * **Nothing seeds the table**, for a reason worth stating where somebody would
 * add one: `schema.sql` is re-executed on *every* open, so an `INSERT … ON
 * CONFLICT DO UPDATE` seed would overwrite an admin's change at every restart.
 * The symptom is "registration turns itself back on after a deploy", which reads
 * as a bug in the toggle rather than in the seed.
 *
 * **When the environment changes under a database override, nothing happens.**
 * The row keeps winning until somebody clears it. The alternative — "the newer
 * one wins" — needs a fourth column remembering what the environment *was*, and
 * produces a rule nobody can reason about after a container restart. Instead
 * `readSetting` carries the provenance and `GET /v1/admin/settings` shows both
 * sides, so an operator can see their new variable being shadowed and clear the
 * override in one act.
 */

/* ------------------------------------------------------------------ *
 * The keys
 * ------------------------------------------------------------------ */

/**
 * Every setting, in one array.
 *
 * Exported and iterated rather than described, so a driver can assert the
 * environment mapping for *all* of them by looping. A second hand-maintained
 * list of environment names is exactly the coupling `.dockerignore` and
 * `deploy/docker/Dockerfile` earned their warning for; here there is one list
 * and one function.
 */
export const SETTING_KEYS = [
  /*
   * First, and deliberately not grouped with `registration.*` or `mail.*`: the
   * admin screen draws these in order and reads a run of one prefix as a
   * section, so filing "how many machines each person gets" under registration
   * would be a heading making a claim about it.
   */
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

/**
 * The one setting whose value never leaves this process.
 *
 * A set rather than a `key === "smtp.password"` test at each call site, because
 * there are three call sites (the projection, the write validator, and the
 * startup banner) and the day a second secret arrives is the day two of them get
 * updated.
 */
export const SECRET_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(["smtp.password"]);

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

/**
 * The environment variable a key falls back to, computed rather than tabulated.
 *
 * `smtp.host` → `REEMOAT_CP_SMTP_HOST`, `mail.public_url` →
 * `REEMOAT_CP_MAIL_PUBLIC_URL`. Pure, so `relaycheck` asserts it over every
 * member of `SETTING_KEYS` in a loop instead of transcribing the list, which
 * would then be free to drift from the ones `main.ts` reads.
 */
export function envNameFor(key: SettingKey): string {
  return `REEMOAT_CP_${key.replace(/\./g, "_").toUpperCase()}`;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

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

/**
 * Compiled once per database, `sessions.ts`' pattern and for its reason.
 *
 * `registrationMode` and `mailConfigured` are reached by `GET /v1/instance`,
 * which the signed-out screen calls on every cold load, and by every public
 * registration route. Keyed by handle so several in-memory databases in one
 * driver cannot collide, and weak so closing one does not retain it.
 */
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

/**
 * One setting, with where it came from.
 *
 * **An empty string in the database is a value, not an absence**, and that is
 * the detail every other function here depends on: `smtp.username = ""` means
 * "this server wants no username", which is a different statement from "fall
 * back to the environment". So the database is consulted for *presence* of a
 * row, never for truthiness of its value — and clearing an override is its own
 * verb rather than writing `""`.
 *
 * The environment half is trimmed and an empty variable is treated as unset,
 * which is the opposite rule and the right one: `FOO=` in a `.env` file is how
 * people comment a value out, and `deploy/lib.sh` writes every value
 * single-quoted so a genuinely-empty-on-purpose environment value is not
 * expressible anyway.
 */
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
  // Exactly these two, and anything else falls back rather than being coerced.
  // `Boolean("false")` is `true`, which is the classic way an operator turns a
  // feature on by trying to turn it off.
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

/**
 * A bounded whole number, falling back on anything else.
 *
 * `readPort`'s rule, generalised because a second numeric setting arrived: a
 * value written by an older release, or an environment variable an operator
 * typo'd, must not throw on a path the relay runs per request. The route's
 * `checkSettingValue` is what refuses a bad value at the door; this is what
 * keeps a bad one that got in from being worse than the default.
 */
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

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export function writeSetting(
  db: DatabaseSync,
  key: SettingKey,
  value: string,
  updatedBy: string | null,
  now = Date.now(),
): void {
  statements(db).write.run(key, value, now, updatedBy);
}

/** Drop the override. The environment underneath it becomes live again. */
export function clearSetting(db: DatabaseSync, key: SettingKey): boolean {
  return Number(statements(db).clear.run(key).changes) === 1;
}

/* ------------------------------------------------------------------ *
 * Validation — hand-written, no zod, like everything else here
 * ------------------------------------------------------------------ */

export const SMTP_SECURITIES = ["implicit_tls", "starttls", "plaintext"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

export const SMTP_AUTHS = ["plain", "login", "none"] as const;
export type SmtpAuth = (typeof SMTP_AUTHS)[number];

/**
 * Whether a value is admissible for a key, as a sentence or `null`.
 *
 * Returns the *message*, so the route can put it in the envelope and the admin
 * screen can render it. Every value is a string, including `"587"` and
 * `"true"` — the column is TEXT, so accepting a JSON number would mean
 * `String()`-ing it on the way in and returning a string on the way out, and a
 * route whose response does not round-trip its own request is the shape of bug
 * this codebase keeps finding.
 */
export function checkSettingValue(key: SettingKey, value: string): string | null {
  if (value.length > 2048) return `${key} is too long`;
  // Control characters in any of these end up in an SMTP header or a shell-read
  // environment file. Refused here rather than at each use.
  if (/[\x00-\x1f\x7f]/.test(value)) return `${key} may not contain control characters`;

  switch (key) {
    /*
     * How many machines each person may own.
     *
     * **`"0"` must pass**, and it is the one value this arm exists to admit: it
     * is the whole point of the setting — an instance where nobody gets a
     * machine until an admin grants them one. A validator written with a
     * truthiness test refuses precisely the value the feature is for, and every
     * other test passes.
     *
     * `String(parsed) === value.trim()` rather than `Number.isInteger` alone,
     * because `Number.parseInt("5 machines")` is `5`: without it the route
     * accepts a string, stores `"5 machines"`, and answers a `GET` with
     * something other than what was `PUT`. This file's own header calls that the
     * shape of bug this codebase keeps finding.
     *
     * The ceiling is `MAX_MACHINES_PER_USER`, which is a *different* bound and
     * stays — anti-abuse rather than commercial. See `machines.ts`.
     */
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
    /*
     * **The two addresses are checked here, because there is nowhere else.**
     *
     * The comment this replaces said they were "checked where they are used" —
     * they were not. `checkEmailAddress` has call sites for every address that
     * arrives in a request *body* and none for one that arrives as a setting, so
     * a display name typed into the From field went straight into
     * `MAIL FROM:<…>` and `From:`, `mailConfigured` reported `configured: true`
     * on the strength of the field being non-empty, and every message on the
     * instance failed — the exact "counts as configured and then every single
     * message dies" outcome this file already warns about for credentials.
     *
     * Empty is allowed through: `mail.reply_to` is optional, and an empty
     * `mail.from` is caught by `mailConfigured` as *missing*, which is a better
     * sentence than "malformed".
     */
    case "mail.from":
    case "mail.reply_to": {
      if (value === "") return null;
      const checked = checkEmailAddress(value);
      return checked.ok ? null : `${key}: ${checked.message}`;
    }
    /*
     * The rest is free text: the domain list is parsed by `parseEmailDomains`,
     * and host, username, password and the instance name are the remote server's
     * business or nobody's. Enumerated rather than left to a `default` arm, so a
     * key added to `SETTING_KEYS` is a compile error here — the house rule this
     * file's sibling switches (`originText`, `incompleteLinkRemedy`) already
     * follow, and the one CLAUDE.md states for every switch over a union.
     */
    case "registration.email_domains":
    case "mail.from_name":
    case "smtp.host":
    case "smtp.username":
    case "smtp.password":
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * The two questions everything else asks
 * ------------------------------------------------------------------ */

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

/**
 * The default port, and it is 587 rather than 25 on purpose.
 *
 * Port 25 outbound is blocked by AWS, GCP, DigitalOcean, Hetzner and Azure, and
 * a blocked port does not refuse — it hangs until the connect timeout. Under the
 * threadpool coupling described in `mail/outbox.ts` a hang is the most expensive
 * failure available, so the default is the one that answers.
 */
export const DEFAULT_SMTP_PORT = 587;

/**
 * Whether this instance can send mail, and what is missing if it cannot.
 *
 * `problems` is a list of human sentences rather than a boolean, because the
 * admin screen has to say *what to fix* — `main.ts`'s "say what to change"
 * discipline applied to a screen instead of stderr. `configured` is exactly
 * `problems.length === 0`, so the two can never disagree.
 */
export function mailConfigured(db: DatabaseSync): { configured: boolean; problems: string[] } {
  const problems: string[] = [];
  if (readString(db, "smtp.host") === null) problems.push("smtp.host is not set");
  if (readString(db, "mail.from") === null) problems.push("mail.from is not set");
  if (readString(db, "mail.public_url") === null) {
    problems.push("mail.public_url is not set, so links in messages would have nowhere to point");
  }

  /*
   * Credentials, when the server is going to ask for them.
   *
   * `sendMessage` skips AUTH entirely when either half is missing, so without
   * this an instance carrying a host, a from address and a URL counts as
   * configured — registration starts demanding an address — and then every
   * single message dies at `530 Authentication required`. Diagnosable from the
   * delivery log, and only after somebody could not sign up.
   *
   * `auth: "none"` is the honest way to say a server wants no credential (a
   * loopback mailpit, a relay that authorises by source address), so it is the
   * setting that turns this check off rather than an empty username doing it by
   * accident.
   */
  const auth = readEnum<SmtpAuth>(db, "smtp.auth", SMTP_AUTHS, "plain");
  if (auth !== "none") {
    if (!usable(readString(db, "smtp.username"))) {
      problems.push("smtp.username is not set — most servers want the full mailbox address");
    }
    if (!usable(readString(db, "smtp.password"))) problems.push("smtp.password is not set");
  }

  /*
   * A warning that is not a refusal, because both readings are real.
   *
   * Most submission servers — Private Email among them — insist the envelope
   * sender is the mailbox you authenticated as, or one of its aliases, and
   * answer `550 sender not allowed` otherwise. But a relay that authorises a
   * whole verified domain legitimately sends as any address in it, so refusing
   * here would refuse a correct configuration. Said rather than enforced, and
   * only when both halves look like addresses.
   */
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

  /*
   * `problems` is therefore not the same question as `configured`, and the split
   * is deliberate: the sender warning is advice, and letting it block delivery
   * would make a correct relay setup unusable. Everything that is *missing*
   * blocks; the one thing that is merely *suspicious* does not.
   */
  return { configured: !problems.some(isMissing), problems };
}

/** A problem that stops a message being sent, as opposed to one that warns. */
function isMissing(problem: string): boolean {
  return problem.includes("is not set");
}

/**
 * Whether a credential half is something you could actually present.
 *
 * **Not the same question as `readSetting`'s "is there a row".** An empty string
 * in the database is a *value* — that rule is about provenance, and it is what
 * lets somebody say "this server wants no username" without falling back to the
 * environment. It is not about usability: `AUTH PLAIN \0\0password` is not a
 * sign-in, it is a malformed one, and the server answers 535 to it.
 *
 * So the way to say a server needs no credential is `smtp.auth = "none"`, which
 * says it, rather than an empty username saying it by omission.
 */
function usable(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * Everything the transport needs, or `null` when this instance cannot send.
 *
 * One function so no caller assembles a half-configuration and discovers the
 * missing half at the socket.
 */
export function mailConfig(db: DatabaseSync): MailConfig | null {
  if (!mailConfigured(db).configured) return null;
  const security = readEnum<SmtpSecurity>(db, "smtp.security", SMTP_SECURITIES, "starttls");
  return {
    host: readString(db, "smtp.host") ?? "",
    port: readPort(db, "smtp.port", DEFAULT_SMTP_PORT),
    security,
    auth: readEnum<SmtpAuth>(db, "smtp.auth", SMTP_AUTHS, "plain"),
    // Normalized through the same predicate `mailConfigured` uses, so the check
    // and the transport cannot disagree about whether there is a credential:
    // `sendMessage` skips AUTH on a `null`, and an empty string reaching it
    // would send `AUTH PLAIN \0\0password` instead.
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
  /**
   * Whether a registration must carry an address. Derived from whether mail
   * works, never stored — the matrix has one input the admin sets and one the
   * SMTP configuration decides, and storing the product of the two is how they
   * come to disagree.
   */
  requiresEmail: boolean;
}

export function registrationMode(db: DatabaseSync): RegistrationMode {
  return {
    enabled: readBoolean(db, "registration.enabled", false),
    requiresEmail: mailConfigured(db).configured,
  };
}

/**
 * The domains registration will accept, lowercased, or an empty list for "any".
 *
 * Comma-separated because it is one field on one screen and a JSON array in a
 * TEXT column would be a second encoding to get wrong. A leading `@` and
 * surrounding whitespace are tolerated because both are what people type.
 */
export function parseEmailDomains(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^@/, "").toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Whether a folded address is admissible here.
 *
 * Takes the *folded* address, so the caller cannot forget to fold and get a
 * refusal that depends on how somebody capitalised their own domain. An empty
 * allowlist admits everything, which is what makes the field optional.
 */
export function emailDomainAllowed(emailFolded: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const at = emailFolded.lastIndexOf("@");
  if (at < 0) return false;
  const domain = emailFolded.slice(at + 1);
  return domains.includes(domain);
}
