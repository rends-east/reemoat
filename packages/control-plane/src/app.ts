import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ALL_SCOPES, AUTH_LEEWAY_MS, LINK_SCOPE, type Scope } from "../../../src/auth.js";
import { bearerToken, boundedInt, describeError, gzipResponses, jsonError, readJsonObject } from "../../../src/http.js";
import {
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  parseAgentClis,
  parseMachineKey,
} from "../../../src/relay/protocol.js";
import { jwkThumbprint, signToken, x25519Jwk, type TokenClaims } from "../../../src/token.js";
import { deviceKeyFor } from "./devices.js";
import { machineKeyFor, setMachineKey } from "./machinekeys.js";
import {
  activePublicKeys,
  activeSigningKeys,
  burnMachineCodes,
  burnGranteeCodes,
  burnUserCodes,
  credentialMatches,
  ensureSigningKey,
  hashCredential,
  issueTunnelKey,
  keyPrefix,
  hasProvisioningKey,
  mintEnrollmentCode,
  mintProvisioningKey,
  mintSigningKey,
  newApiKey,
  newId,
  resolveProvisioningKey,
  retireSigningKey,
  signingKeyRows,
} from "./keys.js";
import {
  burnEmailTokens,
  claimEmailToken,
  deleteEmailState,
  emailOf,
  INVITE_TTL_MS,
  markVerified,
  mintEmailToken,
  readEmailToken,
  RESET_TTL_MS,
  setEmail,
  VERIFY_TTL_MS,
  verifiedOwnerOf,
} from "./emails.js";
import { checkEmailAddress, MAX_EMAIL_CHARS } from "./mail/address.js";
import { mailAccepts, mailHealth, NOTICE_INTERVAL_MS, sentRecently, type MailSender } from "./mail/outbox.js";
import {
  emailChanged,
  emailVerify,
  invitation,
  lifetimeText,
  passwordReset,
  registrationConfirm,
  registrationNotice,
  testMessage,
  type Template,
} from "./mail/templates.js";
import {
  burnRegistration,
  claimRegistration,
  foldName,
  mintRegistration,
  nameTaken,
  nameTakenByAnother,
  pendingForEmail,
  REGISTRATION_TTL_MS,
} from "./registration.js";
import {
  checkSettingValue,
  clearSetting,
  emailDomainAllowed,
  envNameFor,
  isSettingKey,
  mailConfigured,
  parseEmailDomains,
  readSetting,
  readString,
  registrationMode,
  SECRET_SETTING_KEYS,
  SETTING_KEYS,
  writeSetting,
  type SettingKey,
} from "./settings.js";
import {
  createOwnedMachine,
  isUniqueViolation,
  labelIsWellFormed,
  labelOrName,
  MACHINE_LABEL_HELP,
  MACHINE_LABEL_RESERVED,
  MACHINE_LABEL_RESERVED_HELP,
  MAX_MACHINES_PER_USER,
  nameVisibleTo,
  nameVisibleToGrantees,
  ownerOf,
  relabelMachine,
  releaseOwner,
  resolveMachineRef,
  type OwnedMachine,
} from "./machines.js";
import { DEFAULT_TRUSTED_PROXY_HOPS, callerAddressOf } from "./net.js";
import {
  clearMachineLimit,
  effectiveLimit,
  instanceMachineLimit,
  machineCount,
  machineStanding,
  overLimitMachineIds,
  overLimitMachines,
  ownerDisabledMachineIds,
  writeMachineLimit,
} from "./quota.js";
import type { RelayView } from "./relay/registry.js";
import {
  checkPasswordPolicy,
  generatePassword,
  hashPassword,
  PasswordBusyError,
  verifyAgainstDecoy,
  verifyPassword,
} from "./password.js";
import {
  DeviceLimitError,
  MAX_DEVICES_PER_USER,
  adoptDevice,
  listDevices,
  readDeviceId,
  readDeviceInput,
  revokeDevice,
} from "./devices.js";
import { listSessions, mintSession, resolveSession, revokeAllSessions, revokeSession, touchSession } from "./sessions.js";
import {
  addressKey,
  ADDRESS_THROTTLE,
  confirmKey,
  enrollKey,
  LoginThrottle,
  loginKey,
  MAIL_THROTTLE,
  mailKey,
  mailTestKey,
  passwordChangeKey,
  provisionKey,
  registerKey,
  RESET_MAIL_THROTTLE,
  resetKey,
  resetMailKey,
  WRITE_THROTTLE,
  writeKey,
} from "./throttle.js";

// AGPL section 13 source offer: change SOURCE_URL if you run a modified copy. relaycheck pins VERSION to package.json.
const SOURCE_URL = "https://github.com/rends-east/reemoat";
const VERSION = "0.11.0";

// Work answered before it is done. Every deferred body must stay synchronous: main.ts drains the set on SIGTERM before closing the store.
const deferred = new Set<() => void>();

function defer(work: () => void): void {
  deferred.add(work);
  setImmediate(() => {
    // Gone means a drain already ran it, so the same mail is never sent twice.
    if (!deferred.delete(work)) return;
    work();
  });
}

/** Run what is still owed, now. Returns how many. Safe to call more than once. */
export function drainDeferred(): number {
  const owed = [...deferred];
  deferred.clear();
  for (const work of owed) work();
  return owed.length;
}

// Never consulted to verify a token: daemons enroll once and verify every token locally.

export const DEFAULT_TOKEN_TTL_SECONDS = 300;

/** A link capability's life: revocation is the relay reading the row per channel, not expiry (Q7.150). */
export const LINK_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;


/** A token is accepted over nbf minus leeway to exp plus leeway, so below this floor the leeway dominates its lifetime. */
export const MIN_TOKEN_TTL_SECONDS = (2 * AUTH_LEEWAY_MS) / 1000;

const ENROLLMENT_CODE_TTL_MS = 60 * 60 * 1000;

const API_KEY_PREFIX = "rk_";
// Hand mirror of GATE_SCREENS in web/src/gate.ts and LEGAL_DOCS in web/src/legal.ts; relaycheck compares them.
const GATE_SCREEN_PATHS = ["register", "confirm", "forgot", "reset", "verify"] as const;
const LEGAL_DOC_PATHS = ["terms", "acceptable-use", "privacy"] as const;

const APP_HANDOFF_PATH = "app";

const SESSION_PREFIX = "rs_";

// Bounds every body-taking route above THE LINE, where the caller is unauthenticated.
const PUBLIC_BODY_LIMIT_BYTES = 64 * 1024;

// Bounds every authenticated body: readJsonObject buffers it whole on the process that carries every tunnel.
const BODY_LIMIT_BYTES = 256 * 1024;

/** An answer over this is refused rather than truncated. See `POST /v1/me/password`. */
const MAX_PASSWORD_FIELD_CHARS = 512;

const MAX_KEYS_PER_USER = 10;

// Checked at creation only, so a name that predates this rule keeps working.
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const USER_NAME_HELP = "name may contain letters, digits, and . _ - only, and must start with a letter or digit";

const DEFAULT_GRANT_PAGE = 500;
const MAX_GRANT_PAGE = 2000;

// Control-flow marker for a claim that matched nothing inside a transaction: the catch rolls back and answers 409 token_unusable.
class TokenNotClaimed extends Error {
  constructor() {
    super("email token was already spent");
    this.name = "TokenNotClaimed";
  }
}

export interface ControlPlaneOptions {
  db: DatabaseSync;
  issuer: string;
  tokenTtlSeconds: number;
  relayUrl?: string | null;
  // Browser origin per relay_id; absent means relayUrl is the only relay. Daemons always dial relayUrl.
  relayUrls?: Record<string, string> | null;
  // Env only, never a SETTING_KEYS row: the CSP connect-src is built from it once, at construction.
  pluginCatalogueUrl?: string | null;
  appDownloadUrl?: string | null;
  // The gate bundle: sign-up and recovery screens, legal documents and the handoff page. Null serves no HTML.
  gateRoot?: string | null;
  legalDocuments?: boolean;
  relay?: RelayView | null;
  bootstrapScript?: string | null;
  // No route awaits a send, so a mailer that never resolves cannot change a route's status or timing.
  mail?: MailSender | null;
  // How many of your own proxies front this listener; decides how much of x-forwarded-for is believed (net.ts).
  trustedProxyHops?: number;
}

/** src/token.ts's claims plus the three a link adds; signToken serializes whatever it is handed. */
interface LinkTokenClaims extends TokenClaims {
  lnk: string;
  src: string;
  srcl: string;
}

interface Caller {
  userId: string;
  name: string;
  isAdmin: boolean;
  via: "api_key" | "session";
  sessionId: string | null;
  deviceId: string | null;
}

type AppEnv = { Variables: { caller: Caller } };

export function createControlPlaneApp(options: ControlPlaneOptions): Hono<AppEnv> {
  const { db, issuer, tokenTtlSeconds } = options;
  const relayUrl = options.relayUrl ?? null;
  const relayUrls = options.relayUrls ?? null;
  const pluginCatalogueUrl = options.pluginCatalogueUrl ?? null;
  const appDownloadUrl = options.appDownloadUrl ?? null;
  const legalDocuments = options.legalDocuments ?? false;
  const relay = options.relay ?? null;
  const trustedProxyHops = options.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;
  const gateRoot = options.gateRoot ?? null;
  const servesGate = gateRoot !== null && existsSync(gateRoot);
  const app = new Hono<AppEnv>();

  // First, so it wraps every route below: Hono runs middleware in registration order.
  app.use("*", gzipResponses());

  // Headers above every route, since a use registered below a route handler never runs for it. HTML is no-cache and hashed assets immutable, decided by the served type.
  // CSP on documents only, no HSTS (TLS ends at a proxy); connect-src lists the relay as https and wss, which CSP treats as different sources.
  const relayOrigins = connectOrigins(relayUrl, relayUrls);
  // The manifest origin goes in img-src as well as connect-src: manifests are fetched, icons are drawn as images.
  const catalogueOrigin = originOf(pluginCatalogueUrl);
  const marketOrigins = catalogueOrigin === null ? "" : ` ${catalogueOrigin} ${PLUGIN_MANIFEST_ORIGIN}`;
  const marketImages = catalogueOrigin === null ? "" : ` ${PLUGIN_MANIFEST_ORIGIN}`;
  const MODEL_CATALOGUE_ORIGIN = "https://openrouter.ai";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob:${marketImages}`,
    "font-src 'self'",
    `connect-src 'self'${relayOrigins}${marketOrigins} ${MODEL_CATALOGUE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    if (c.res.status !== 200) return;
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.res.headers.set("cache-control", "no-cache");
      c.res.headers.set("content-security-policy", csp);
      // Beside frame-ancestors, which supersedes it, because not every browser reads both.
      c.res.headers.set("x-frame-options", "DENY");
      c.res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
      return;
    }
    if (c.req.path.startsWith("/assets/")) {
      c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    }
  });

  // Feeds every throttle key's address half, so x-forwarded-for is believed only within trustedProxyHops (net.ts).
  const callerAddress = (c: Context): string => {
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return callerAddressOf(c.req.header("x-forwarded-for"), incoming?.socket?.remoteAddress, trustedProxyHops);
  };

  const relayOnline = (machineId: string): boolean => relay !== null && relay.isOnline(machineId);

  const lastSeenStmt = db.prepare("SELECT at FROM machine_last_seen WHERE machine_id = ?");
  const lastSeenAt = (machineId: string): number | null => {
    try {
      const row = lastSeenStmt.get(machineId);
      return row === undefined ? null : Number(row["at"]);
    } catch {
      // Bookkeeping, not authorization: null is the honest cannot-tell.
      return null;
    }
  };

  // For browsers only: daemons keep the shared relayUrl for life. No map, no tunnel or an unmapped slot all fall back to it.
  const relayUrlFor = (machineId: string): string | null => {
    if (relay === null || relayUrls === null) return relayUrl;
    const slot = relay.relayFor(machineId);
    if (slot === null) return relayUrl;
    // Object.hasOwn, so a slot named like a prototype member cannot resolve to an inherited function.
    return Object.hasOwn(relayUrls, slot) ? relayUrls[slot]! : relayUrl;
  };

  const throttle = new LoginThrottle();

  // A second instance with a looser threshold: an address key is shared by everyone behind one NAT.
  const addressThrottle = new LoginThrottle(ADDRESS_THROTTLE);

  const mailThrottle = new LoginThrottle(MAIL_THROTTLE);

  const resetMailThrottle = new LoginThrottle(RESET_MAIL_THROTTLE);

  const writeThrottle = new LoginThrottle(WRITE_THROTTLE);

  // Null means carry on. Recorded with fail, since a legitimate write is still a write.
  // There are **sixteen** call sites; relaycheck compares that word with the calls.
  const spendWrite = (c: Context, what: string): Response | null => {
    const caller = c.get("caller");
    const key = writeKey(caller.userId, what);
    const decision = writeThrottle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
    writeThrottle.fail(key);
    return null;
  };

  const mail = options.mail ?? null;

  const adminMachine = (row: Record<string, unknown>): Record<string, unknown> =>
    adminMachineProjection(
      row,
      relayUrlFor,
      relayOnline,
      (id) => machineStanding(db, id)?.over ?? false,
      (id) => {
        const owner = ownerOf(db, id);
        return owner === null ? null : { userId: owner.userId, label: owner.label };
      },
      lastSeenAt,
    );

  const publicOrigin = (): string => readString(db, "mail.public_url") ?? "";

  const instanceName = (): string => {
    try {
      return new URL(publicOrigin()).host;
    } catch {
      return issuer;
    }
  };

  const send = (to: string, kind: Parameters<MailSender["enqueue"]>[0]["kind"], template: Template, notAfter: number): boolean => {
    if (mail === null) return false;
    return (
      mail.enqueue({
        to,
        kind,
        subject: template.subject,
        text: template.text,
        html: template.html,
        notAfter,
      }) !== null
    );
  };

  // Keyed on the recipient and shared by registration, forgot and address change, so three an hour is three in total.
  const mayMail = (emailFolded: string): boolean => {
    if (!mailThrottle.check(mailKey(emailFolded)).allowed) return false;
    mailThrottle.fail(mailKey(emailFolded));
    return true;
  };

  // Independent of mayMail, so a registration flood cannot take an owner's recovery with it.
  const mayMailReset = (emailFolded: string): boolean => {
    if (!resetMailThrottle.check(resetMailKey(emailFolded)).allowed) return false;
    resetMailThrottle.fail(resetMailKey(emailFolded));
    return true;
  };

  // One register notice per owner per NOTICE_INTERVAL_MS, read from the outbox so a restart does not clear it.
  const noticeAlreadySent = (emailFolded: string, now: number): boolean =>
    mail !== null && sentRecently(db, emailFolded, "register_notice", NOTICE_INTERVAL_MS, now);

  // Only a throw is unhealthy (a relay may create the schema before any key). database is a token, never driver text, which carries the file path.
  const healthRead = db.prepare("SELECT 1 AS ok FROM signing_keys LIMIT 1");
  app.get("/health", (c) => {
    let database = "ok";
    try {
      healthRead.get();
    } catch {
      // Nothing to report it through, and the text is what must not go out.
      database = "unavailable";
    }
    return c.json(
      {
        ok: database === "ok",
        issuer,
        // Same reasoning as the daemon's: a clock is not a secret, and short-lived
        // tokens make skew a real way to be locked out.
        time: Date.now(),
        tokenTtlSeconds,
        database,
      },
      database === "ok" ? 200 : 503,
    );
  });

  // Daemons do not poll this; it is for inspection and manual re-enrollment.
  app.get("/v1/jwks", (c) =>
    // activePublicKeys: an unauthenticated path never loads a private key.
    c.json({ keys: activePublicKeys(db).map((key) => ({ kid: key.kid, jwk: key.jwk })) }),
  );

  app.post("/v1/login", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    const password = body["password"];
    // A name or an email address. Bounded by MAX_EMAIL_CHARS so a legal address is not refused differently from invalid_login.
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_EMAIL_CHARS) {
      return jsonError(c, 400, "bad_request", "a name or email address is required");
    }
    if (typeof password !== "string" || password.length === 0) {
      return jsonError(c, 400, "bad_request", "password is required");
    }

    // Keyed on name plus address, never the bare name, so nobody can lock an owner out; the address counter catches sprays.
    const address = callerAddress(c);
    const attemptKey = loginKey(name, address);
    const sprayKey = addressKey(address);
    const decision = throttle.check(attemptKey);
    const spray = addressThrottle.check(sprayKey);
    if (!decision.allowed || !spray.allowed) {
      // Whichever block is longer decides the header: retrying at the shorter one
      // would be refused again by the other, which reads as the header being wrong.
      const retryAfterSeconds = Math.max(decision.retryAfterSeconds, spray.retryAfterSeconds);
      return tooManyAttempts(c, retryAfterSeconds, "too many sign-in attempts — wait and try again");
    }

    // Recorded before the await so concurrent guesses see it; succeed undoes it below.
    throttle.fail(attemptKey);
    addressThrottle.fail(sprayKey);

    // A name first, then a verified address only: the order resolves a legacy name holding an @ without a distinguishable refusal.
    const submitted = name.trim();
    let user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE name = ?").get(submitted);
    if (user === undefined) {
      const checked = checkEmailAddress(submitted);
      if (checked.ok) {
        const owner = verifiedOwnerOf(db, checked.folded);
        if (owner !== null) {
          user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?").get(owner);
        }
      }
    }
    const stored =
      user === undefined
        ? undefined
        : db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(String(user["id"]));

    try {
      // Every branch spends a real verification's cost, or timing becomes a user oracle.
      if (user === undefined || stored === undefined) {
        // The decoy takes the same public lane as a real verification, or queueing becomes the oracle.
        await verifyAgainstDecoy(password, "public");
        return jsonError(c, 401, "invalid_login", "those sign-in details do not match");
      }

      const verified = await verifyPassword(password, String(stored["hash"]), "public");
      if (!verified.ok) {
        // No `fail` here — the attempt was recorded before the await.
        return jsonError(c, 401, "invalid_login", "those sign-in details do not match");
      }

      // Cleared before the disabled check: the correct password is not guessing.
      throttle.succeed(attemptKey);
      // forgive, never succeed: this key is shared by everyone at the address and also counts register and forgot.
      addressThrottle.forgive(sprayKey);

      // Only after the password verified, so the account's state leaks only to its owner.
      if (user["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this account has been disabled");
      }

      // Best effort: a rehash failure must never fail a sign-in that already succeeded.
      if (verified.needsRehash) {
        try {
          // The public lane: a best-effort rehash above THE LINE must not take an authenticated slot.
          const rehashed = await hashPassword(password, "public");
          db.prepare("UPDATE user_passwords SET hash = ?, updated_at = ? WHERE user_id = ?").run(
            rehashed,
            Date.now(),
            String(user["id"]),
          );
        } catch {
          // The sign-in stands. The row is re-tried on the next one.
        }
      }

      // Resolved only after the KDF. An id not adopted registers a fresh device, and the cap is swallowed so sign-in never fails on it.
      const offered = readDeviceInput(body["device"]);
      let deviceId: string | null = null;
      if (offered !== null) {
        try {
          deviceId = adoptDevice(db, String(user["id"]), readDeviceId((body["device"] as Record<string, unknown>)["id"]), offered);
        } catch (error) {
          if (!(error instanceof DeviceLimitError)) throw error;
        }
      }

      const session = mintSession(
        db,
        String(user["id"]),
        {
          ip: address,
          userAgent: c.req.header("user-agent") ?? null,
        },
        deviceId,
      );
      return c.json({
        token: session.token,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        deviceId,
        user: {
          id: String(user["id"]),
          name: String(user["name"]),
          isAdmin: Number(user["is_admin"]) === 1,
        },
        // So a client can tell "my clock is wrong" from "the token was refused",
        // exactly as `POST /v1/tokens` does.
        serverTime: Date.now(),
      });
    } catch (error) {
      if (error instanceof PasswordBusyError) {
        return passwordBusy(c, "too many sign-in attempts in flight — try again in a moment");
      }
      throw error;
    }
  });

  app.post("/v1/enroll", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const code = body["code"];
    // Optional: an unreadable key becomes null rather than failing the one request a daemon makes.
    const announcedKey = parseMachineKey(body["machineKey"]);
    if (typeof code !== "string" || code.length === 0) {
      return jsonError(c, 400, "bad_request", "code is required");
    }

    // Counted on every attempt: a daemon redeems once, so the bound only bites a flood.
    const address = callerAddress(c);
    const guess = enrollKey(address);
    const guessed = addressThrottle.check(guess);
    if (!guessed.allowed) return tooManyAttempts(c, guessed.retryAfterSeconds);
    addressThrottle.fail(guess);

    const now = Date.now();
    const hash = hashCredential(code);

    // Single use and expiry enforced by one conditional UPDATE; exactly one caller sees one changed row.
    const claimed = db
      .prepare(
        "UPDATE enrollment_codes SET used_at = ?, used_from = ? " +
          "WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(now, address, hash, now);

    if (claimed.changes !== 1) {
      return jsonError(
        c,
        409,
        "code_unusable",
        "this enrollment code is unknown, already used, or expired",
      );
    }

    const row = db.prepare("SELECT machine_id, created_by FROM enrollment_codes WHERE code_hash = ?").get(hash);
    const machineId = String(row?.["machine_id"] ?? "");
    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) {
      return jsonError(c, 409, "machine_missing", "the machine this code was issued for no longer exists");
    }
    // Checked after the claim, so a code aimed at a revoked machine is burned
    // rather than left usable for the moment somebody un-revokes it.
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    // Written only here, where the redeemed code is known. NULL rather than empty, so IS NULL stays the one spelling of unknown.
    const enroller = row?.["created_by"];
    db.prepare("UPDATE machines SET enrolled_at = ?, enrolled_by = ? WHERE id = ?").run(
      now,
      typeof enroller === "string" && enroller.length > 0 ? enroller : null,
      machineId,
    );

    const keys = activePublicKeys(db);
    if (keys.length === 0) {
      return jsonError(c, 503, "no_signing_key", "this control plane has no signing key");
    }

    // Minted even with no relay, so switching a relay on later needs no re-enrollment.
    const tunnelKey = issueTunnelKey(db, machineId);

    // The one place a machine key pin is replaced: redeeming a code means the machine is starting again.
    if (announcedKey !== null) setMachineKey(db, machineId, announcedKey, now);

    // Every active key: a daemon never comes back, so a rotation in flight must be handed over whole.
    return c.json({
      machineId,
      issuer,
      keys: keys.map((key) => ({ kid: key.kid, jwk: key.jwk })),
      tunnelKey,
      relay: relayUrl === null ? null : { url: relayUrl },
      serverTime: now,
    });
  });

  // Every body-taking route in this block needs its own bodyLimit: the 256 KiB limit sits below the credential gate.
  // A taken name answers 409; a taken address answers the same 200 as a fresh one, plus a notice to its owner.

  // Not folded into /health, so product state stays off the liveness path. Two booleans: registration closed with mail on is a real state.
  // No bodyLimit: a GET carries no body, so the middleware would be inert.
  app.get("/v1/instance", (c) => {
    const mode = registrationMode(db);
    return c.json({
      registration: { enabled: mode.enabled, requiresEmail: mode.requiresEmail },
      mail: { configured: mailConfigured(db).configured },
      app: { download: appDownloadUrl },
      legal: { documents: legalDocuments },
      plugins: { catalogue: pluginCatalogueUrl },
      // The AGPL §13 offer. Public because the people it is owed to are the ones
      // who have not signed in — see `SOURCE_URL`.
      source: { url: SOURCE_URL, version: VERSION },
      serverTime: Date.now(),
    });
  });

  // Hash first, branch second, so every outcome costs the same scrypt. The public lane is shared with login.
  app.post("/v1/register", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const mode = registrationMode(db);
    if (!mode.enabled) {
      return jsonError(c, 403, "registration_disabled", "this control plane does not accept new accounts");
    }

    const name = body["name"];
    const password = body["password"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required");
    }
    const trimmed = name.trim();
    if (!USER_NAME.test(trimmed)) return jsonError(c, 400, "bad_request", USER_NAME_HELP);
    if (typeof password !== "string" || password.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "password is required");
    }
    const weak = checkPasswordPolicy(password, trimmed);
    if (weak !== null) return jsonError(c, 400, "weak_password", weak);

    // Required only when this deployment publishes the documents; nothing is stored (Q3.599, Q7.134, Q1.638).
    if (legalDocuments && body["acceptedTerms"] !== true) {
      return jsonError(c, 400, "terms_not_accepted", "the terms have to be accepted to create an account");
    }

    // Required exactly when mail works and refused when it does not, so nobody believes in a recovery address they lack.
    const rawEmail = body["email"];
    let email: { address: string; folded: string } | null = null;
    if (mode.requiresEmail) {
      const checked = checkEmailAddress(rawEmail);
      if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);
      const domains = parseEmailDomains(readString(db, "registration.email_domains"));
      if (!emailDomainAllowed(checked.folded, domains)) {
        // The same sentence as a malformed address: the allowlist is not published.
        return jsonError(c, 400, "bad_request", "that address cannot be used to sign up here");
      }
      email = { address: checked.address, folded: checked.folded };
    } else if (rawEmail !== undefined && rawEmail !== null && rawEmail !== "") {
      return jsonError(c, 400, "bad_request", "this control plane cannot send mail, so it cannot take an address");
    }

    const address = callerAddress(c);
    const attempt = registerKey(trimmed, address);
    const spray = addressKey(address);
    const decision = throttle.check(attempt);
    const sprayed = addressThrottle.check(spray);
    if (!decision.allowed || !sprayed.allowed) {
      return tooManyAttempts(
        c,
        Math.max(decision.retryAfterSeconds, sprayed.retryAfterSeconds),
        "too many sign-up attempts — wait and try again",
      );
    }
    // Never cleared: a registration presents no credential, so the record counts accounts per host.
    throttle.fail(attempt);
    addressThrottle.fail(spray);

    let hash: string;
    try {
      hash = await hashPassword(password, "public");
    } catch (error) {
      if (error instanceof PasswordBusyError) {
        return passwordBusy(c, "too many sign-ups in flight — try again in a moment");
      }
      throw error;
    }

    const now = Date.now();
    // nameTakenByAnother, not nameTaken: signing up again is how a lost confirmation is resent.
    if (nameTakenByAnother(db, trimmed, email?.folded ?? null, now)) {
      return jsonError(c, 409, "name_taken", "somebody already has that name");
    }

    if (!mode.requiresEmail) {
      const userId = newId("u");
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(userId, trimmed, now);
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(userId, hash, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (isUniqueViolation(error)) return jsonError(c, 409, "name_taken", "somebody already has that name");
        throw error;
      }
      const session = mintSession(
        db,
        userId,
        {
          ip: address,
          userAgent: c.req.header("user-agent") ?? null,
        },
        null,
      );
      return c.json(
        {
          pending: false,
          token: session.token,
          sessionId: session.id,
          expiresAt: session.expiresAt,
          user: { id: userId, name: trimmed, isAdmin: false },
          serverTime: now,
        },
        201,
      );
    }

    const folded = email?.folded ?? "";
    const existingOwner = verifiedOwnerOf(db, folded);
    const pending = pendingForEmail(db, folded, now);

    // Address spoken for: same status and body as a fresh one, plus at most one notice a day to its owner.
    // Exact, never folded: a fold-equal pending name on this address must not resend a stranger's stored link.
    const mine = pending !== null && pending.name === trimmed;
    // A fold-equal but different name holding this address is refused like a fold-equal existing user.
    if (pending !== null && !mine && foldName(pending.name) === foldName(trimmed)) {
      return jsonError(c, 409, "name_taken", "somebody already has that name");
    }

    if (existingOwner !== null || pending !== null) {
      if (existingOwner !== null && !noticeAlreadySent(folded, now) && mayMail(folded)) {
        send(
          email?.address ?? "",
          "register_notice",
          registrationNotice({
            instance: instanceName(),
            signInUrl: `${publicOrigin()}/`,
            forgotUrl: `${publicOrigin()}/forgot`,
          }),
          now + REGISTRATION_TTL_MS,
        );
      } else if (pending !== null && mine && mayMail(folded)) {
        // Mails only what pending stored, nothing from this request: taking the caller's password here would be an account takeover.
        const again = mintRegistration(
          db,
          { name: pending.name, email: pending.email, passwordHash: pending.passwordHash },
          REGISTRATION_TTL_MS,
          now,
        );
        send(
          pending.email,
          "register",
          registrationConfirm({
            name: pending.name,
            url: `${publicOrigin()}/confirm#t=${again.token}`,
            lifetime: lifetimeText(REGISTRATION_TTL_MS),
          }),
          again.expiresAt,
        );
      } else if (existingOwner === null && !mine && mayMail(folded)) {
        // Somebody else's sign-up holds this address: mint the caller's own link beside it, never pending's values, and let the mailbox choose.
        const own = mintRegistration(
          db,
          { name: trimmed, email: email?.address ?? "", passwordHash: hash },
          REGISTRATION_TTL_MS,
          now,
        );
        send(
          email?.address ?? "",
          "register",
          registrationConfirm({
            name: trimmed,
            url: `${publicOrigin()}/confirm#t=${own.token}`,
            lifetime: lifetimeText(REGISTRATION_TTL_MS),
          }),
          own.expiresAt,
        );
      }
      return c.json({ pending: true, expiresAt: now + REGISTRATION_TTL_MS });
    }

    const minted = mintRegistration(
      db,
      { name: trimmed, email: email?.address ?? "", passwordHash: hash },
      REGISTRATION_TTL_MS,
      now,
    );
    if (mayMail(folded)) {
      // A full outbox is swallowed: a 503 here would tell a free address from a taken one.
      send(
        email?.address ?? "",
        "register",
        registrationConfirm({
          name: trimmed,
          url: `${publicOrigin()}/confirm#t=${minted.token}`,
          lifetime: lifetimeText(REGISTRATION_TTL_MS),
        }),
        minted.expiresAt,
      );
    }
    return c.json({ pending: true, expiresAt: minted.expiresAt });
  });

  // Creates the account and nothing else: no credential in the answer, and no await between BEGIN and COMMIT.
  app.post(
    "/v1/register/confirm",
    bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }),
    async (c) => {
      const body = await readJsonObject(c);
      const token = body?.["token"];
      if (typeof token !== "string" || token.length === 0 || token.length > 200) {
        return jsonError(c, 400, "bad_request", "token is required");
      }

      const address = callerAddress(c);
      const key = confirmKey(address);
      const decision = throttle.check(key);
      if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
      throttle.fail(key);

      // Re-checked so closing registration stops links already in flight; the domain allowlist deliberately is not.
      if (!registrationMode(db).enabled) {
        return jsonError(c, 403, "registration_disabled", "sign-ups are closed on this instance");
      }

      const now = Date.now();
      const claimed = claimRegistration(db, token, address, now);
      if (claimed === null) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      throttle.succeed(key);

      const userId = newId("u");
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(
          userId,
          claimed.name,
          now,
        );
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(
          userId,
          claimed.passwordHash,
          now,
        );
        db.prepare(
          "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run(userId, claimed.email, claimed.emailFolded, now, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (isUniqueViolation(error)) {
          // Burn the row: its name or address is taken, so the link can only fail again.
          const taken = nameTaken(db, claimed.name, now);
          burnRegistration(db, claimed.id, taken ? "name_taken" : "email_taken", now);
          return taken
            ? jsonError(c, 409, "name_taken", "somebody took that name while this link was waiting")
            : jsonError(c, 409, "email_taken", "somebody else confirmed that address while this link was waiting");
        }
        throw error;
      }

      // No session: a confirmation link proves the address, not knowledge of the password.
      return c.json({ user: { id: userId, name: claimed.name }, serverTime: now }, 201);
    },
  );

  // Always 200 with an identical body, and no arm hashes, so both branches match in shape and time.
  app.post("/v1/forgot", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    // A 409 rather than a 200, and it leaks nothing `GET /v1/instance` does not
    // already publish. A 200 here would promise a message that can never arrive.
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail");
    }

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["email"]);
    const address = callerAddress(c);
    const spray = addressKey(address);
    const sprayed = addressThrottle.check(spray);
    if (!sprayed.allowed) return tooManyAttempts(c, sprayed.retryAfterSeconds);

    // Refused before the counter is spent: a request naming no address must not cost a sign-in slot.
    if (!checked.ok) return c.json({ sent: true });
    addressThrottle.fail(spray);

    // Everything that tells an owned address from a free one runs after the response. Deferred work must stay synchronous (drainDeferred).
    const now = Date.now();
    defer(() => {
      try {
        // Checked before spending an attempt or burning the live link, both one-way. The response is already sent, so only stderr hears.
        if (!mailAccepts(db, "reset", now)) {
          console.error("forgot: the outbox is full, so no recovery mail was queued and no attempt was spent");
          return;
        }
        const userId = verifiedOwnerOf(db, checked.folded);
        if (userId === null || !mayMailReset(checked.folded)) return;
        const user = db.prepare("SELECT name, disabled_at FROM users WHERE id = ?").get(userId);
        if (user === undefined || user["disabled_at"] !== null) return;
        const minted = mintEmailToken(db, userId, "reset", checked.folded, RESET_TTL_MS, now);
        const queued = send(
          checked.address,
          "reset",
          passwordReset({
            name: String(user["name"]),
            url: `${publicOrigin()}/reset#t=${minted.token}`,
            lifetime: lifetimeText(RESET_TTL_MS),
          }),
          minted.expiresAt,
        );
        // A refused send gives the attempt back with forgive, never succeed: the key follows the recipient, and succeed would reset all three.
        if (!queued) {
          resetMailThrottle.forgive(resetMailKey(checked.folded));
          console.error("forgot: the outbox refused a recovery mail, so the attempt was given back");
        }
      } catch (error) {
        console.error(`forgot failed after answering: ${describeError(error)}`);
      }
    });

    return c.json({ sent: true });
  });

  // Read, validate, hash, then claim, so a refused password does not burn the link. API keys are kept; apiKeysActive lets the screen offer to revoke them.
  app.post("/v1/reset", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const token = body["token"];
    const next = body["newPassword"];
    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return jsonError(c, 400, "bad_request", "token is required");
    }
    if (typeof next !== "string" || next.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "newPassword is required");
    }

    const address = callerAddress(c);
    const key = resetKey(address);
    const decision = throttle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);

    // Only a bad token spends the counter and nothing calls succeed, so replaying a live token cannot reset the bound.
    const guessed = () => {
      throttle.fail(key);
      return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
    };

    const now = Date.now();
    const held = readEmailToken(db, token, now);
    if (held === null || held.purpose !== "reset") {
      return guessed();
    }

    const user = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?").get(held.userId);
    if (user === undefined) {
      return guessed();
    }
    if (user["disabled_at"] !== null) {
      burnEmailTokens(db, held.userId, "user_disabled", now);
      return jsonError(c, 403, "user_disabled", "this account has been disabled");
    }

    // The address must still be the one the token was minted for. Spending the link verifies it, which is how an invitation works.
    const current = emailOf(db, held.userId);
    if (current === null || current.emailFolded !== held.emailFolded) {
      burnEmailTokens(db, held.userId, "email_changed", now);
      return guessed();
    }

    const weak = checkPasswordPolicy(next, String(user["name"]));
    // Before the claim, so the link survives a refused password.
    if (weak !== null) return jsonError(c, 400, "weak_password", weak);

    let hash: string;
    try {
      hash = await hashPassword(next, "public");
    } catch (error) {
      if (error instanceof PasswordBusyError) return passwordBusy(c);
      throw error;
    }

    let revoked = 0;
    db.exec("BEGIN");
    try {
      // The claim sits inside the transaction so a rollback leaves the link unspent.
      if (!claimEmailToken(db, token, address, now)) throw new TokenNotClaimed();
      db.prepare(
        "INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
      ).run(held.userId, hash, now);
      markPasswordChanged(db, held.userId, now);
      revoked = revokeAllSessions(db, held.userId, null, now);
      burnEmailTokens(db, held.userId, "password_changed", now);
      // Spending the link verifies the address. A false return means the row moved since emailOf, so abort.
      if (current.verifiedAt === null && !markVerified(db, held.userId, held.emailFolded, now)) {
        throw new TokenNotClaimed();
      }
      // An invitation is a reset on an account with no password, so this also clears its obligation.
      db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(held.userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      // Thrown, not returned, so the one exit stays the ROLLBACK: a dangling BEGIN breaks the next writer on the shared connection.
      if (error instanceof TokenNotClaimed) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      if (isUniqueViolation(error)) {
        return jsonError(c, 409, "email_taken", "somebody else has already confirmed that address");
      }
      throw error;
    }

    const keysActive = Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(held.userId)?.[
        "n"
      ] ?? 0,
    );

    const session = mintSession(
      db,
      held.userId,
      {
        ip: address,
        userAgent: c.req.header("user-agent") ?? null,
      },
      null,
    );
    return c.json({
      token: session.token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: {
        id: held.userId,
        name: String(user["name"]),
        isAdmin: Number(user["is_admin"]) === 1,
      },
      sessionsRevoked: revoked,
      apiKeysActive: keysActive,
      serverTime: now,
    });
  });

  // Carries its own credential, a pk_ key, so it sits above THE LINE. Creates the machine, raises the owner's limit to fit and mints the code.
  // The daemon never sees the key: it still makes exactly one control-plane request.
  app.post("/v1/provision", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: payloadTooLarge }), async (c) => {
    // Counted on every attempt, by address: the key is long-lived and fleet-wide, so guessing it is the attack.
    const address = callerAddress(c);
    const guess = provisionKey(address);
    const guessed = addressThrottle.check(guess);
    if (!guessed.allowed) return tooManyAttempts(c, guessed.retryAfterSeconds);
    addressThrottle.fail(guess);

    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const presented = body["key"];
    if (typeof presented !== "string" || presented.length === 0) {
      return jsonError(c, 400, "bad_request", "key is required");
    }
    const keyId = resolveProvisioningKey(db, presented);
    // One answer for "no such key", "revoked" and "there is no key on this
    // instance", so a caller cannot learn which by asking.
    if (keyId === null) {
      return jsonError(c, 401, "invalid_provisioning_key", "that provisioning key is not valid");
    }

    const userRef = body["user"];
    if (typeof userRef !== "string" || userRef.trim().length === 0) {
      return jsonError(c, 400, "bad_request", "user is required — an id or a name");
    }
    const named = readLabel(body["machine"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);

    // All rows, not the first: the folded name is not unique, so an ambiguous name is refused rather than guessed.
    const wanted = userRef.trim();
    const byId = db.prepare("SELECT id, name, disabled_at FROM users WHERE id = ?").get(wanted);
    const byName = byId
      ? []
      : db.prepare("SELECT id, name, disabled_at FROM users WHERE lower(name) = ?").all(wanted.toLowerCase());
    if (byName.length > 1) {
      return jsonError(
        c,
        409,
        "user_ambiguous",
        `more than one account is named "${wanted}" bar case — provision by user id instead`,
      );
    }
    const user = byId ?? byName[0];
    if (!user) return jsonError(c, 404, "user_not_found", "no such user");
    // A disabled owner's machines are switched off at creation, so refuse with the reason.
    if (user["disabled_at"] !== null) {
      return jsonError(c, 403, "user_disabled", "that user is disabled");
    }
    const ownerId = String(user["id"]);

    ensureSigningKey(db);

    if (nameVisibleTo(db, ownerId, named.label)) {
      return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
    }

    // Raise to owned plus one, never limit plus one; createOwnedMachine still clamps to the fleet ceiling.
    const before = effectiveLimit(db, ownerId);
    const owned = machineCount(db, ownerId);

    // Already over the limit is refused: raising it here would undo an admin's suspension with a key that is not an admin credential (Q1.503).
    if (owned > before.limit) {
      return jsonError(
        c,
        409,
        "machine_limit",
        `that user has ${owned} machines against a limit of ${before.limit}, so ${owned - before.limit} are switched off — raise their limit first`,
      );
    }

    const raisedTo = owned >= before.limit ? Math.min(owned + 1, MAX_MACHINES_PER_USER) : null;

    // The machine first, the limit only once it exists: a failed provision must not widen the quota.
    const created = createOwnedMachine(db, ownerId, named.label, ALL_SCOPES, raisedTo ?? before.limit);
    if ("error" in created) {
      if (created.error === "too_many") {
        return jsonError(
          c,
          409,
          "machine_limit",
          `that user is at the fleet-wide ceiling of ${MAX_MACHINES_PER_USER} machines`,
        );
      }
      return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
    }
    if (raisedTo !== null) writeMachineLimit(db, ownerId, raisedTo, keyId);

    // created_by is the provisioning key's id, not the owner's: the code's only forensic trail.
    const enrollment = mintEnrollmentCode(db, created.id, keyId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      {
        machine: { id: created.id, name: named.label },
        owner: { id: ownerId, name: String(user["name"]) },
        enrollment: { code: enrollment.code, expiresAt: enrollment.expiresAt },
        controlPlaneUrl: installOrigin(c, trustedProxyHops),
        machineLimitRaisedTo: raisedTo,
      },
      201,
    );
  });

  // THE LINE: every route registered below needs a credential. A new public route goes above it.
  app.use("/v1/*", callerAuth(db));

  // After the gate, so an anonymous caller is refused before any body is read.
  app.use("/v1/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: payloadTooLarge }));

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.get("caller").isAdmin) {
      return jsonError(c, 403, "forbidden", "this endpoint requires an admin key");
    }
    return next();
  };

  app.get("/v1/me", (c) => {
    const caller = c.get("caller");
    const address = emailOf(db, caller.userId);
    const quota = effectiveLimit(db, caller.userId);
    const owned = machineCount(db, caller.userId);
    return c.json({
      id: caller.userId,
      name: caller.name,
      isAdmin: caller.isAdmin,
      via: caller.via,
      hasPassword: db.prepare("SELECT 1 FROM user_passwords WHERE user_id = ?").get(caller.userId) !== undefined,
      // Not user_passwords.updated_at: the sign-in rehash and admin temporary passwords rewrite that.
      passwordChangedAt: passwordChangedAt(db, caller.userId),
      // Carried, not derived: an unverified address reserves nothing and forgot will not mail it.
      email: address?.email ?? null,
      emailVerified: address !== null && address.verifiedAt !== null,
      // The only way to discover the obligation, which is why GET /v1/me sits above THE SECOND LINE.
      mustChangePassword: obligationOf(db, caller.userId) !== null,
      mustChangePasswordReason: obligationOf(db, caller.userId),
      // canAddMachine is computed here so the rule has one owner; the limit's source is deliberately withheld.
      machineCount: owned,
      machineLimit: quota.limit,
      canAddMachine: owned < quota.limit,
    });
  });

  // Null when verified, else the refusal. Both callers spend passwordChangeKey, keyed on user id so a login spray cannot block it.
  // The caller decides whether to ask; narrower than the deleted proveCurrentPassword, it cannot grow its own exemption (Q1.630, Q7.81).
  const verifyCurrentPassword = async (
    c: Context,
    userId: string,
    current: unknown,
    storedHash: string,
  ): Promise<Response | null> => {
    if (current === undefined || current === null || current === "") {
      return jsonError(c, 400, "bad_request", "currentPassword is required");
    }
    if (typeof current !== "string" || current.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "currentPassword must be a string");
    }
    const key = passwordChangeKey(userId);
    const decision = throttle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
    throttle.fail(key);
    const verified = await verifyPassword(current, storedHash, "authenticated");
    if (!verified.ok) {
      return jsonError(c, 401, "invalid_password", "that is not your current password");
    }
    throttle.succeed(key);
    return null;
  };

  // Between here and THE SECOND LINE: the routes an account owing a password change can still reach.

  // currentPassword is required whenever a password row exists, even under a session, so a stolen token cannot take the account.
  app.post("/v1/me/password", async (c) => {
    // Spends a write slot: a correct password never arms passwordChangeKey, and two scrypts per request could starve the public lane (Q1.413, Q1.407).
    const writeGuard = spendWrite(c, "password");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const next = body["newPassword"];
    const current = body["currentPassword"];
    if (typeof next !== "string" || next.length > MAX_PASSWORD_FIELD_CHARS) {
      return jsonError(c, 400, "bad_request", "newPassword is required");
    }
    if (current !== undefined && (typeof current !== "string" || current.length > MAX_PASSWORD_FIELD_CHARS)) {
      return jsonError(c, 400, "bad_request", "currentPassword must be a string");
    }

    const problem = checkPasswordPolicy(next, caller.name);
    if (problem !== null) return jsonError(c, 400, "weak_password", problem);

    const stored = db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(caller.userId);

    try {
      if (stored !== undefined) {
        // Whichever credential presents: a key is no way round the password on the route that replaces it.
        const refused = await verifyCurrentPassword(c, caller.userId, current, String(stored["hash"]));
        if (refused !== null) return refused;
      }

      const hash = await hashPassword(next, "authenticated");
      const now = Date.now();

      // One transaction with no await: dropping the obligation must commit with the new hash.
      let revoked = 0;
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at",
        ).run(caller.userId, hash, now);
        markPasswordChanged(db, caller.userId, now);

        // Every other session goes and this one stays. Under an API key null revokes them all, and the key survives.
        revoked = revokeAllSessions(db, caller.userId, caller.sessionId, now);

        // Any live reset link dies with the password it would have replaced.
        burnEmailTokens(db, caller.userId, "password_changed", now, "reset");

        // The wall comes down here, and only here and at `POST /v1/reset`.
        db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(caller.userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return c.json({ changed: true, sessionsRevoked: revoked });
    } catch (error) {
      if (error instanceof PasswordBusyError) return passwordBusy(c);
      throw error;
    }
  });

  app.delete("/v1/me/sessions/current", (c) => {
    const caller = c.get("caller");
    if (caller.sessionId === null) {
      return jsonError(c, 409, "not_a_session", "this credential is an API key; there is no session to end");
    }
    revokeSession(db, caller.sessionId);
    return c.json({ revoked: true });
  });

  // revokedCount, not revoked: the single-session deletes answer a boolean under that name.
  app.delete("/v1/me/sessions", (c) => {
    const caller = c.get("caller");
    const keep = c.req.query("keepCurrent") === "1" ? caller.sessionId : null;
    return c.json({ revokedCount: revokeAllSessions(db, caller.userId, keep) });
  });

  // Above THE SECOND LINE: the app calls it on every start, including while a password change is owed. Refuses an API key, which has no session to bind.
  app.post("/v1/me/devices", async (c) => {
    const writeGuard = spendWrite(c, "device");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    if (caller.via !== "session") {
      return jsonError(c, 409, "device_needs_session", "an API key has no device — sign in to register one");
    }
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const input = readDeviceInput(body);
    if (input === null) {
      return jsonError(c, 400, "bad_request", "name and platform are required");
    }

    let deviceId: string;
    try {
      deviceId = adoptDevice(db, caller.userId, readDeviceId(body["id"]), input);
    } catch (error) {
      if (error instanceof DeviceLimitError) {
        return jsonError(
          c,
          409,
          "device_limit",
          `you have ${String(MAX_DEVICES_PER_USER)} devices registered, which is the most allowed — ` +
            "retire one under Settings → Devices and nothing else changes",
        );
      }
      throw error;
    }

    // Binds the device to the asking session, so revoking the device ends that sign-in.
    db.prepare("UPDATE user_sessions SET device_id = ? WHERE id = ? AND user_id = ?").run(
      deviceId,
      caller.sessionId,
      caller.userId,
    );
    return c.json({
      id: deviceId,
      name: input.name,
      platform: input.platform,
      hasKey: deviceKeyFor(db, deviceId) !== null,
    });
  });

  // THE SECOND LINE: below it an account owing a password change gets 403, not the 401 clients read as a dead credential.
  // Not a security boundary: minted tokens and open sockets keep working.
  app.use("/v1/*", requirePasswordCurrent(db));

  /** Where you are signed in. Bounded by the per-user cap, so it needs no paging. */
  app.get("/v1/me/sessions", (c) => {
    const caller = c.get("caller");
    return c.json({
      sessions: listSessions(db, caller.userId).map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        ip: row.ip,
        userAgent: row.userAgent,
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        current: row.id === caller.sessionId,
      })),
    });
  });

  app.get("/v1/me/devices", (c) => {
    const caller = c.get("caller");
    return c.json({
      devices: listDevices(db, caller.userId).map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt,
        lastSeenAt: row.lastSeenAt,
        // A boolean, never the key: false for a row from before keys and for a lost key alike.
        hasKey: row.hasKey,
        keySetAt: row.keySetAt,
        current: caller.deviceId !== null && row.id === caller.deviceId,
      })),
      limit: MAX_DEVICES_PER_USER,
    });
  });

  // Scoped to the caller inside revokeDevice; missing and not yours are both 404. Retiring the device you hold is allowed.
  app.delete("/v1/me/devices/:id", (c) => {
    const writeGuard = spendWrite(c, "device_revoke");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const revoked = revokeDevice(db, caller.userId, c.req.param("id"));
    if (revoked === null) return jsonError(c, 404, "device_not_found", "no such device");
    return c.json({ revoked: true, sessionsRevoked: revoked.sessionsRevoked });
  });

  app.delete("/v1/me/sessions/:id", (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    // Scoped to the caller, so another account's session id is 404, never 403.
    const row = db.prepare("SELECT id FROM user_sessions WHERE id = ? AND user_id = ?").get(id, caller.userId);
    if (!row) return jsonError(c, 404, "session_not_found", "no such session");
    revokeSession(db, id);
    return c.json({ revoked: true });
  });

  // Your own API keys: only the holder lists and revokes them (Q1.631).

  app.get("/v1/me/keys", (c) => c.json({ keys: apiKeyRows(db, c.get("caller").userId) }));

  app.delete("/v1/me/keys/:keyId", (c) => {
    const writeGuard = spendWrite(c, "key_revoke");
    if (writeGuard !== null) return writeGuard;

    if (!revokeApiKey(db, c.get("caller").userId, c.req.param("keyId"))) {
      return jsonError(c, 404, "key_not_found", "no such API key, or already revoked");
    }
    return c.json({ revoked: true });
  });

  // A session is enough, no password asked (Q1.630): every key is listed and one tap to revoke. Capped at MAX_KEYS_PER_USER.
  app.post("/v1/me/keys", async (c) => {
    const writeGuard = spendWrite(c, "key");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");

    const live = Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(caller.userId)?.[
        "n"
      ] ?? 0,
    );
    if (live >= MAX_KEYS_PER_USER) {
      return jsonError(
        c,
        409,
        "key_limit",
        `an account may hold ${MAX_KEYS_PER_USER} API keys at once — revoke one first`,
      );
    }

    const key = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      caller.userId,
      key.prefix,
      key.hash,
      Date.now(),
    );
    return c.json({ apiKey: key.key }, 201);
  });

  // A session is enough; an API key must prove the password first, since the address is the reset channel (Q1.630, Q1.403).
  // An address somebody else verified is stored as an unverified claim, not refused: the verification answers 409.
  app.put("/v1/me/email", async (c) => {
    // Spends a write slot: every call enqueues two mails into the shared outbox, and mayMail follows the recipient (Q1.413, Q7.79).
    const writeGuard = spendWrite(c, "email");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail, so it cannot confirm an address");
    }

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["email"]);
    if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);

    // An API key proves the password before any write or mail; an account with no password row is exempt, its key being the proof.
    if (caller.via === "api_key") {
      const stored = db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(caller.userId);
      if (stored !== undefined) {
        try {
          const refused = await verifyCurrentPassword(c, caller.userId, body?.["currentPassword"], String(stored["hash"]));
          if (refused !== null) return refused;
        } catch (error) {
          if (error instanceof PasswordBusyError) return passwordBusy(c);
          throw error;
        }
      }
    }

    const existing = emailOf(db, caller.userId);

    if (!mayMail(checked.folded)) {
      return tooManyAttempts(
        c,
        mailThrottle.check(mailKey(checked.folded)).retryAfterSeconds,
        "too many messages to that address — wait and try again",
      );
    }

    const now = Date.now();
    // The old address is notified before the row is overwritten, verified or not: for a session it is the owner's only warning.
    if (existing !== null && existing.emailFolded !== checked.folded) {
      send(
        existing.email,
        "email_changed",
        emailChanged({
          instance: instanceName(),
          name: caller.name,
          newDomain: checked.folded.slice(checked.folded.lastIndexOf("@") + 1),
        }),
        now + VERIFY_TTL_MS,
      );
    }

    setEmail(db, caller.userId, checked.address, now);
    // Any outstanding reset points at an address this account no longer has.
    burnEmailTokens(db, caller.userId, "email_changed", now, "reset");

    const minted = mintEmailToken(db, caller.userId, "verify", checked.folded, VERIFY_TTL_MS, now);
    send(
      checked.address,
      "verify",
      emailVerify({
        name: caller.name,
        url: `${publicOrigin()}/verify#t=${minted.token}`,
        lifetime: lifetimeText(VERIFY_TTL_MS),
      }),
      minted.expiresAt,
    );

    return c.json({ email: checked.address, verified: false });
  });

  // Below THE LINE: the token alone must not change what an account can be reset from.
  app.post("/v1/me/email/verify", async (c) => {
    const caller = c.get("caller");
    const body = await readJsonObject(c);
    const token = body?.["token"];
    if (typeof token !== "string" || token.length === 0 || token.length > 200) {
      return jsonError(c, 400, "bad_request", "token is required");
    }

    const now = Date.now();
    const held = readEmailToken(db, token, now);
    if (held === null || held.purpose !== "verify" || held.userId !== caller.userId) {
      return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
    }

    const current = emailOf(db, caller.userId);
    if (current === null || current.emailFolded !== held.emailFolded) {
      return jsonError(c, 409, "token_unusable", "this link is for an address this account no longer has");
    }

    // The claim sits inside the transaction so a refused verification leaves the link live; the one exit is the ROLLBACK.
    db.exec("BEGIN");
    try {
      if (!claimEmailToken(db, token, callerAddress(c), now)) throw new TokenNotClaimed();
      // Checked: a user_emails row that moved since emailOf matches nothing.
      if (!markVerified(db, caller.userId, held.emailFolded, now)) throw new TokenNotClaimed();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (error instanceof TokenNotClaimed) {
        return jsonError(c, 409, "token_unusable", "this link is unknown, already used, or expired");
      }
      if (isUniqueViolation(error)) {
        return jsonError(c, 409, "email_taken", "somebody else has already confirmed that address");
      }
      throw error;
    }
    return c.json({ email: current.email, verified: true });
  });

  // Owner plus grantees: an ownerless machine may still carry other people's grants, so no owner is not no users.
  const dependants = (machineId: string): { owner: OwnedMachine | null; grantees: string[] } => ({
    owner: ownerOf(db, machineId),
    grantees: db
      .prepare("SELECT user_id FROM grants WHERE machine_id = ?")
      .all(machineId)
      .map((row) => String(row["user_id"])),
  });

  app.get("/v1/machines", (c) => {
    const caller = c.get("caller");
    const rows = db
      .prepare(
        "SELECT m.id, m.name, m.enrolled_at, m.enrolled_by, g.scopes, o.label FROM grants g " +
          "JOIN machines m ON m.id = g.machine_id " +
          "LEFT JOIN machine_owners o ON o.machine_id = m.id AND o.user_id = g.user_id " +
          "WHERE g.user_id = ? AND m.revoked_at IS NULL " +
          "ORDER BY m.name ASC",
      )
      .all(caller.userId);
    // Over-limit machines are listed, not filtered, so the owner can still retire one.
    const overLimit = overLimitMachineIds(db);
    const ownerDisabled = ownerDisabledMachineIds(db);
    // Names whoever else enrolled a machine for this caller, so a freed name re-registered on someone else's hardware is visible. A name to show, not a flag to trust.
    const enrolledByIds = new Set(
      rows.map((row) => String(row["enrolled_by"] ?? "")).filter((id) => id.length > 0 && id !== caller.userId),
    );
    const enrolledByName = new Map<string, string>();
    if (enrolledByIds.size > 0) {
      const ids = [...enrolledByIds];
      for (const row of db
        .prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids)) {
        enrolledByName.set(String(row["id"]), String(row["name"]));
      }
    }
    // Empty but enrolled means it enrolled before enrolled_by was recorded, so it is named rather than read as your own.
    // A pk_ id is a provisioning key; an id with no users row is a deleted account.
    const enrolledByFor = (id: string, hasEnrolled: boolean): string | null => {
      if (id.length === 0) return hasEnrolled ? "somebody this control plane did not record" : null;
      if (id === caller.userId) return null;
      if (id.startsWith("pk_")) return "a provisioning key";
      return enrolledByName.get(id) ?? "a deleted account";
    };
    return c.json({
      machines: rows.map((row) => ({
        id: String(row["id"]),
        name: labelOrName(row["label"], String(row["name"])),
        enrolled: row["enrolled_at"] !== null,
        owned: row["label"] !== null,
        // Past its owner's limit, so dead for grantees too; they learn why here.
        overLimit: overLimit.has(String(row["id"])),
        ownerDisabled: ownerDisabled.has(String(row["id"])),
        scopes: parseScopes(String(row["scopes"])),
        relayUrl: relayUrlFor(String(row["id"])),
        relayOnline: relayOnline(String(row["id"])),
        lastSeenAt: lastSeenAt(String(row["id"])),
        enrolledBy: enrolledByFor(String(row["enrolled_by"] ?? ""), row["enrolled_at"] !== null),
      })),
    });
  });

  // Registers, grants to its creator and mints the code in one request.
  // Registering for somebody else goes through /v1/admin/machines, bounded by enrolledBy naming who did it (Q1.631, Q7.74).
  app.post("/v1/machines", async (c) => {
    const writeGuard = spendWrite(c, "machine");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const named = readLabel(body["name"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;

    ensureSigningKey(db);

    if (nameVisibleTo(db, caller.userId, label)) {
      return jsonError(c, 409, "machine_exists", "you can already see a machine with that name");
    }

    const quota = effectiveLimit(db, caller.userId);
    const created = createOwnedMachine(db, caller.userId, label, ALL_SCOPES, quota.limit);
    if ("error" in created) {
      if (created.error === "too_many") {
        return jsonError(
          c,
          409,
          "machine_limit",
          quota.limit === 0
            ? "this instance does not hand out machines by default. Ask whoever runs it to raise your limit."
            : `you may own at most ${quota.limit} machine${quota.limit === 1 ? "" : "s"}. ` +
                "Retire one, or ask whoever runs this control plane to raise the limit.",
          { owned: machineCount(db, caller.userId), limit: quota.limit },
        );
      }
      return jsonError(c, 409, "machine_exists", "you already have a machine with that name");
    }

    const enrollment = mintEnrollmentCode(db, created.id, caller.userId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      {
        machine: {
          id: created.id,
          name: label,
          enrolled: false,
          owned: true,
          overLimit: false,
          ownerDisabled: false,
          scopes: [...ALL_SCOPES],
          relayUrl,
          relayOnline: false,
        },
        enrollment: { code: enrollment.code, expiresAt: enrollment.expiresAt },
        // From the server, not the browser's origin: in dev that is Vite's proxy port, which a machine cannot reach.
        controlPlaneUrl: installOrigin(c, trustedProxyHops),
      },
      201,
    );
  });

  // A machine the caller does not own resolves to null and answers 404, never 403, so ids cannot be probed.
  const ownedMachine = (c: Context<AppEnv>): OwnedMachine | null => {
    const owner = ownerOf(db, c.req.param("id") ?? "");
    if (owner === null) return null;
    return owner.userId === c.get("caller").userId ? owner : null;
  };

  app.patch("/v1/machines/:id", async (c) => {
    const writeGuard = spendWrite(c, "machine_rename");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const named = readLabel(body["name"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;
    // Excluding this machine, or renaming it to the name it already has would
    // refuse itself.
    if (nameVisibleTo(db, c.get("caller").userId, label, owned.id)) {
      return jsonError(c, 409, "machine_exists", "you can already see a machine with that name");
    }
    const failed = relabelMachine(db, owned.id, owned.userId, label);
    if (failed !== null) return jsonError(c, 409, "machine_exists", "you already have a machine with that name");
    return c.json({ id: owned.id, name: label, owned: true });
  });

  // Allowed whether or not the machine has enrolled: redeeming rotates its tunnel credential, which only the owner may ask for.
  app.post("/v1/machines/:id/enrollments", (c) => {
    const writeGuard = spendWrite(c, "enroll");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const machine = db.prepare("SELECT revoked_at FROM machines WHERE id = ?").get(owned.id);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    const standing = machineStanding(db, owned.id);
    if (standing !== null && standing.over) {
      return jsonError(
        c,
        403,
        "machine_over_limit",
        "this machine is over your machine limit and is switched off, so a new code would not " +
          "bring it back. Retire another machine, or ask whoever runs this control plane to raise the limit.",
      );
    }
    ensureSigningKey(db);
    const minted = mintEnrollmentCode(db, owned.id, c.get("caller").userId, ENROLLMENT_CODE_TTL_MS);
    return c.json(
      { code: minted.code, machineId: owned.id, expiresAt: minted.expiresAt, controlPlaneUrl: installOrigin(c, trustedProxyHops) },
      201,
    );
  });

  // Revoke, burn its codes and release ownership in one transaction: a live code would undo a partial revoke.
  app.post("/v1/machines/:id/revoke", (c) => {
    const writeGuard = spendWrite(c, "machine_revoke");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const now = Date.now();
    let changed = 0;
    let burned = 0;
    // Never return between BEGIN and COMMIT: the shared connection would stay inside the transaction.
    db.exec("BEGIN");
    try {
      changed = Number(
        db
          .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, owned.id).changes,
      );
      if (changed === 1) {
        burned = burnMachineCodes(db, owned.id, now);
        releaseOwner(db, owned.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (changed !== 1) return jsonError(c, 404, "machine_not_found", "no such machine, or already revoked");
    return c.json({
      revoked: true,
      enrollmentCodesInvalidated: burned,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  // Listing, sharing and unsharing resolve through ownedMachine, since a grant is full access (Q1.11): a machine you do not own is a 404.

  /** Who this machine is shared with. The owner's own grant is not a share. */
  app.get("/v1/machines/:id/grants", (c) => {
    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const rows = db
      .prepare(
        "SELECT g.user_id, g.scopes, u.name FROM grants g JOIN users u ON u.id = g.user_id " +
          "WHERE g.machine_id = ? AND g.user_id != ? ORDER BY g.created_at ASC, g.user_id ASC",
      )
      .all(owned.id, owned.userId);
    return c.json({
      machineId: owned.id,
      grants: rows.map((row) => ({
        userId: String(row["user_id"]),
        name: String(row["name"]),
        scopes: parseScopes(String(row["scopes"])),
      })),
    });
  });

  // By user id only, since a name lookup would be a user-enumeration oracle (Q7.78); the owner's own grant is refused.
  app.put("/v1/machines/:id/grants", async (c) => {
    const writeGuard = spendWrite(c, "machine_share");
    if (writeGuard !== null) return writeGuard;

    // Every await precedes ownedMachine, so the ownership check and the insert run in one synchronous turn.
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const userId = body["userId"];
    if (typeof userId !== "string" || userId.length === 0) {
      return jsonError(c, 400, "bad_request", "userId is required");
    }
    const scopes = readScopes(body["scopes"]);
    if (scopes === null) {
      return jsonError(c, 400, "bad_request", `scopes must be an array drawn from ${ALL_SCOPES.join(", ")}`);
    }

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (userId === owned.userId) {
      return jsonError(c, 409, "grant_is_owner", "you own this machine, so you already hold every scope on it");
    }
    // A suspended account is refused: the grant would silently go live when it is re-enabled.
    const target = db.prepare("SELECT id, disabled_at FROM users WHERE id = ?").get(userId);
    if (!target) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    if (target["disabled_at"] !== null) {
      return jsonError(c, 409, "user_disabled", "that account is suspended; enable it before sharing with them");
    }

    db.prepare(
      "INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, machine_id) DO UPDATE SET scopes = excluded.scopes",
    ).run(userId, owned.id, scopes.join(" "), Date.now());

    return c.json({ userId, machineId: owned.id, scopes });
  });

  // Stop sharing a machine you own; the owner's own grant is refused, or the machine would vanish from their list.
  app.delete("/v1/machines/:id/grants", (c) => {
    const writeGuard = spendWrite(c, "machine_unshare");
    if (writeGuard !== null) return writeGuard;

    const owned = ownedMachine(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const userId = c.req.query("userId") ?? "";
    if (userId.length === 0) return jsonError(c, 400, "bad_request", "userId is required");
    if (userId === owned.userId) {
      return jsonError(
        c,
        409,
        "grant_is_owner",
        "you own this machine; retiring it is the verb for giving up your own access",
      );
    }
    const changed = db.prepare("DELETE FROM grants WHERE user_id = ? AND machine_id = ?").run(userId, owned.id);
    if (changed.changes !== 1) return jsonError(c, 404, "grant_not_found", "no such grant");
    return c.json({ revoked: true, outstandingTokensExpireWithinSeconds: tokenTtlSeconds });
  });

  // Give up a share made to you: your own grant only, and never on a machine you own.
  app.delete("/v1/machines/:id/grants/me", (c) => {
    const writeGuard = spendWrite(c, "grant_leave");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const machineId = c.req.param("id") ?? "";
    const owner = ownerOf(db, machineId);
    if (owner !== null && owner.userId === caller.userId) {
      return jsonError(
        c,
        409,
        "grant_is_owner",
        "you own this machine; retiring it is the verb for giving up your own access",
      );
    }
    // One 404 for no grant and no machine, so machine ids cannot be probed.
    const changed = db.prepare("DELETE FROM grants WHERE user_id = ? AND machine_id = ?").run(caller.userId, machineId);
    if (changed.changes !== 1) return jsonError(c, 404, "grant_not_found", "no such grant");
    return c.json({ revoked: true, outstandingTokensExpireWithinSeconds: tokenTtlSeconds });
  });

  // A short-lived token for one machine; every check lives here, since the daemon only verifies what the token carries.
  app.post("/v1/tokens", async (c) => {
    const writeGuard = spendWrite(c, "token");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const machineRef = body["machine"];
    if (typeof machineRef !== "string" || machineRef.length === 0) {
      return jsonError(c, 400, "bad_request", "machine is required");
    }

    const resolvedId = resolveMachineRef(db, caller.userId, machineRef);
    const machine =
      resolvedId === null
        ? undefined
        : db.prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ?").get(resolvedId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");

    const machineId = String(machine["id"]);

    const grant = db
      .prepare("SELECT scopes FROM grants WHERE user_id = ? AND machine_id = ?")
      .get(caller.userId, machineId);
    // The same 404 as an unknown machine. A user with no grant should not be
    // able to enumerate the fleet by watching 403s come back instead of 404s.
    if (!grant) return jsonError(c, 404, "machine_not_found", "no such machine");

    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    if (machine["enrolled_at"] === null) {
      return jsonError(c, 409, "machine_not_enrolled", "this machine has not enrolled yet");
    }

    // Checked after the grant: asked earlier it would tell any valid token whether a machine exists and is over its limit.
    const standing = machineStanding(db, machineId);
    if (standing !== null && standing.ownerDisabled) {
      return jsonError(
        c,
        403,
        "owner_disabled",
        "this machine's owner has been disabled, so it is switched off",
      );
    }
    if (standing !== null && standing.over) {
      return jsonError(
        c,
        403,
        "machine_over_limit",
        standing.ownerId === caller.userId
          ? "this machine is over your machine limit and is switched off. Retire another machine, or ask " +
              "whoever runs this control plane to raise the limit — nothing has been deleted."
          : "this machine is over its owner's machine limit and is switched off",
      );
    }

    const keys = activeSigningKeys(db);
    const signing = keys[0];
    if (!signing) return jsonError(c, 503, "no_signing_key", "this control plane has no signing key");

    const scopes = parseScopes(String(grant["scopes"]));
    if (scopes.length === 0) {
      return jsonError(c, 403, "no_scopes", "this grant carries no usable scopes");
    }

    // Unbound only for an API key, which has no device; a signed-in installation without a device key is refused.
    const deviceKey = caller.deviceId === null ? null : deviceKeyFor(db, caller.deviceId);
    if (caller.deviceId !== null && deviceKey === null) {
      return jsonError(
        c,
        409,
        "device_key_required",
        "this installation has not registered a device key, so no capability can be bound to it",
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      iss: issuer,
      sub: caller.userId,
      // The audience binding. Without it a token minted for one machine would
      // verify perfectly at every other machine that trusts this same key.
      aud: machineId,
      jti: newId("t"),
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + tokenTtlSeconds,
      scp: scopes,
      // RFC 7800 confirmation: the daemon compares it with the handshake's static key, using the thumbprint function in src/token.ts.
      ...(deviceKey === null ? {} : { cnf: { jkt: jwkThumbprint(x25519Jwk(Buffer.from(deviceKey, "base64url"))) } }),
      // Advisory, never a decision, and only so a refusal can name an
      // installation somebody can go and look at.
      ...(caller.deviceId === null ? {} : { dev: caller.deviceId }),
    };

    return c.json({
      token: signToken(claims, signing.kid, signing.privateKey),
      expiresAt: claims.exp * 1000,
      scopes,
      machine: {
        id: machineId,
        name: String(machine["name"]),
        relayUrl: relayUrlFor(machineId),
        relayOnline: relayOnline(machineId),
        // The static key the machine must answer with; null until it announces one, and the client never falls back without it.
        key: machineKeyFor(db, machineId),
      },
      // So a client can tell "my clock is wrong" from "the token was refused".
      serverTime: Date.now(),
    });
  });

  // Resolved like POST /v1/tokens, then owned by the caller or a 404, so the link routes probe nothing.
  const ownedRef = (c: Context<AppEnv>): OwnedMachine | null => {
    const caller = c.get("caller");
    const resolved = resolveMachineRef(db, caller.userId, c.req.param("id") ?? "");
    const owner = resolved === null ? null : ownerOf(db, resolved);
    return owner !== null && owner.userId === caller.userId ? owner : null;
  };

  // A link per other machine the caller owns, each with a capability bound to this machine's pinned key (Q7.150).
  app.post("/v1/machines/:id/links", (c) => {
    const writeGuard = spendWrite(c, "links");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const source = ownedRef(c);
    const row =
      source === null
        ? undefined
        : db.prepare("SELECT name, enrolled_at, revoked_at FROM machines WHERE id = ?").get(source.id);
    if (source === null || !row) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (row["revoked_at"] !== null) return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    if (row["enrolled_at"] === null) {
      return jsonError(c, 409, "machine_not_enrolled", "this machine has not enrolled yet");
    }
    const standing = machineStanding(db, source.id);
    if (standing !== null && standing.ownerDisabled) {
      return jsonError(c, 403, "owner_disabled", "this machine's owner has been disabled, so it is switched off");
    }
    if (standing !== null && standing.over) {
      return jsonError(
        c,
        403,
        "machine_over_limit",
        "this machine is over your machine limit and is switched off, so it can reach no other machine. Retire " +
          "another machine, or ask whoever runs this control plane to raise the limit.",
      );
    }
    // From this service's own pin, never from the request: it is the key the target will demand on the handshake.
    const sourceKey = machineKeyFor(db, source.id);
    if (sourceKey === null) {
      return jsonError(
        c,
        409,
        "machine_key_missing",
        "this machine has not announced its key yet, so no link can be bound to it. Update it and let it reconnect.",
      );
    }
    const signing = activeSigningKeys(db)[0];
    if (!signing) return jsonError(c, 503, "no_signing_key", "this control plane has no signing key");

    const targets = db
      .prepare(
        "SELECT o.machine_id, o.label, m.machine_key FROM machine_owners o " +
          "JOIN machines m ON m.id = o.machine_id " +
          "JOIN grants g ON g.machine_id = o.machine_id AND g.user_id = o.user_id " +
          "WHERE o.user_id = ? AND o.machine_id != ? AND m.enrolled_at IS NOT NULL AND m.revoked_at IS NULL " +
          "AND m.machine_key IS NOT NULL ORDER BY o.created_at ASC, o.machine_id ASC",
      )
      .all(caller.userId, source.id)
      .map((target) => ({
        id: String(target["machine_id"]),
        name: String(target["label"]),
        key: String(target["machine_key"]),
      }))
      .filter((target) => {
        const held = machineStanding(db, target.id);
        return held === null || (!held.ownerDisabled && !held.over);
      });

    const now = Date.now();
    const findLive = db.prepare(
      "SELECT id FROM machine_links WHERE source_machine_id = ? AND target_machine_id = ? AND revoked_at IS NULL",
    );
    const insert = db.prepare(
      "INSERT INTO machine_links (id, source_machine_id, target_machine_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const linkIds: string[] = [];
    // Never return between BEGIN and COMMIT: the shared connection would stay inside the transaction.
    db.exec("BEGIN");
    try {
      for (const target of targets) {
        const live = findLive.get(source.id, target.id);
        const id = live === undefined ? newId("lk") : String(live["id"]);
        if (live === undefined) insert.run(id, source.id, target.id, caller.userId, now);
        linkIds.push(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const jkt = jwkThumbprint(x25519Jwk(Buffer.from(sourceKey, "base64url")));
    const sourceLabel = labelOrName(source.label, String(row["name"]));
    const seconds = Math.floor(now / 1000);
    return c.json({
      links: targets.map((target, index) => {
        const claims: LinkTokenClaims = {
          iss: issuer,
          sub: caller.userId,
          aud: target.id,
          jti: newId("t"),
          iat: seconds,
          nbf: seconds,
          exp: seconds + LINK_TOKEN_TTL_SECONDS,
          // The only scope a link carries, and no grant ever stores it: an older daemon drops it and refuses every route.
          scp: [LINK_SCOPE],
          cnf: { jkt },
          lnk: linkIds[index]!,
          src: source.id,
          srcl: sourceLabel,
        };
        return {
          id: claims.lnk,
          token: signToken(claims, signing.kid, signing.privateKey),
          expiresAt: claims.exp * 1000,
          target: { id: target.id, name: target.name, key: target.key, relayUrl: relayUrlFor(target.id) },
        };
      }),
    });
  });

  // Both directions, and only while both ends are live; each end is named as the caller names it.
  app.get("/v1/machines/:id/links", (c) => {
    const caller = c.get("caller");
    const owned = ownedRef(c);
    if (owned === null) return jsonError(c, 404, "machine_not_found", "no such machine");
    const rows = db
      .prepare(
        "SELECT l.id, l.source_machine_id, l.target_machine_id, l.created_at, " +
          "s.name AS source_name, so.label AS source_label, t.name AS target_name, tl.label AS target_label " +
          "FROM machine_links l " +
          "JOIN machines s ON s.id = l.source_machine_id " +
          "JOIN machines t ON t.id = l.target_machine_id " +
          "LEFT JOIN machine_owners so ON so.machine_id = s.id AND so.user_id = ? " +
          "LEFT JOIN machine_owners tl ON tl.machine_id = t.id AND tl.user_id = ? " +
          "WHERE l.revoked_at IS NULL AND s.revoked_at IS NULL AND t.revoked_at IS NULL " +
          "AND (l.source_machine_id = ? OR l.target_machine_id = ?) " +
          "ORDER BY l.created_at ASC, l.id ASC",
      )
      .all(caller.userId, caller.userId, owned.id, owned.id);
    return c.json({
      links: rows.map((row) => ({
        id: String(row["id"]),
        source: {
          id: String(row["source_machine_id"]),
          name: labelOrName(row["source_label"], String(row["source_name"])),
        },
        target: {
          id: String(row["target_machine_id"]),
          name: labelOrName(row["target_label"], String(row["target_name"])),
        },
        createdAt: Number(row["created_at"]),
      })),
    });
  });

  // Owner of either end. Idempotent, so a retried DELETE after a lost answer is a 204 rather than a 404.
  app.delete("/v1/links/:id", (c) => {
    const writeGuard = spendWrite(c, "links");
    if (writeGuard !== null) return writeGuard;

    const caller = c.get("caller");
    const linkId = c.req.param("id") ?? "";
    const row = db.prepare("SELECT source_machine_id, target_machine_id FROM machine_links WHERE id = ?").get(linkId);
    const ownsAnEnd =
      row !== undefined &&
      [row["source_machine_id"], row["target_machine_id"]].some(
        (machineId) => ownerOf(db, String(machineId))?.userId === caller.userId,
      );
    // One 404 for no such link and somebody else's, so link ids cannot be probed.
    if (!ownsAnEnd) return jsonError(c, 404, "link_not_found", "no such link");
    db.prepare("UPDATE machine_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), linkId);
    return c.body(null, 204);
  });

  // Given an email this invites and returns no secret; without one, a generated password is shown once under a change obligation.
  app.post("/v1/admin/users", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required and must be at most 200 characters");
    }
    const trimmed = name.trim();
    if (!USER_NAME.test(trimmed)) return jsonError(c, 400, "bad_request", USER_NAME_HELP);
    const isAdmin = body["isAdmin"] === true;

    const canInvite = mailConfigured(db).configured;
    const rawEmail = body["email"];
    let invite: { address: string; folded: string } | null = null;
    if (rawEmail !== undefined && rawEmail !== null && rawEmail !== "") {
      if (!canInvite) {
        return jsonError(c, 409, "mail_unconfigured", "this control plane cannot send mail, so it cannot invite");
      }
      const checked = checkEmailAddress(rawEmail);
      if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);
      if (verifiedOwnerOf(db, checked.folded) !== null) {
        // Naming the clash is no oracle here: an admin can already list every account.
        return jsonError(c, 409, "email_taken", "another account has already confirmed that address");
      }
      invite = { address: checked.address, folded: checked.folded };
    }

    const existing = db.prepare("SELECT id FROM users WHERE name = ?").get(trimmed);
    if (existing) return jsonError(c, 409, "user_exists", "a user with that name already exists");

    const password = invite === null ? generatePassword() : null;
    let hash: string | null = null;
    if (password !== null) {
      const problem = checkPasswordPolicy(password, trimmed);
      // Unreachable unless generatePassword and the policy disagree.
      if (problem !== null) return jsonError(c, 503, "overloaded", `could not generate a password: ${problem}`);
      try {
        hash = await hashPassword(password, "authenticated");
      } catch (error) {
        if (error instanceof PasswordBusyError) return passwordBusy(c);
        throw error;
      }
    }

    const userId = newId("u");
    const now = Date.now();
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)").run(
        userId,
        trimmed,
        isAdmin ? 1 : 0,
        now,
      );
      if (hash !== null) {
        db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(userId, hash, now);
        db.prepare("INSERT INTO password_obligations (user_id, reason, created_at) VALUES (?, 'admin_created', ?)").run(
          userId,
          now,
        );
      }
      if (invite !== null) {
        db.prepare(
          "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, NULL, ?)",
        ).run(userId, invite.address, invite.folded, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      // The name check above precedes the KDF, so a concurrent create can trip the unique name index: answer the same 409.
      if (isUniqueViolation(error)) {
        return jsonError(c, 409, "user_exists", "a user with that name already exists");
      }
      throw error;
    }

    if (invite !== null) {
      // Minted after COMMIT: mintEmailToken opens its own transaction on this connection.
      const minted = mintEmailToken(db, userId, "reset", invite.folded, INVITE_TTL_MS, now);
      const queued = send(
        invite.address,
        "invite",
        invitation({
          name: trimmed,
          invitedBy: c.get("caller").name,
          url: `${publicOrigin()}/reset#t=${minted.token}`,
          lifetime: lifetimeText(INVITE_TTL_MS),
        }),
        minted.expiresAt,
      );
      return c.json(
        { id: userId, name: trimmed, isAdmin, invited: true, email: invite.address, mailQueued: queued },
        201,
      );
    }

    // The only time this value exists anywhere. Only its hash was stored.
    return c.json({ id: userId, name: trimmed, isAdmin, invited: false, password, mustChangePassword: true }, 201);
  });

  // Resend an invitation to the account's own address; nothing is issued to the caller, and an account with a password is refused.
  app.post("/v1/admin/users/:id/invite", requireAdmin, (c) => {
    const userId = c.req.param("id");
    const user = db.prepare("SELECT name, disabled_at FROM users WHERE id = ?").get(userId);
    if (user === undefined) return jsonError(c, 404, "user_not_found", "no such user");
    if (user["disabled_at"] !== null) {
      return jsonError(c, 409, "user_disabled", "enable the account before inviting them again");
    }
    if (db.prepare("SELECT 1 FROM user_passwords WHERE user_id = ?").get(userId) !== undefined) {
      return jsonError(c, 409, "user_has_password", "this account already has a password — they can sign in or use the forgotten-password link");
    }
    const address = emailOf(db, userId);
    if (address === null) {
      return jsonError(c, 409, "user_has_no_email", "this account has no address to invite");
    }
    if (mail === null || !mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "configure SMTP before sending an invitation");
    }

    const now = Date.now();
    // Supersedes any live invitation, `mintEmailToken`'s one-live-link rule, so a
    // resend cannot leave two working links for one account.
    const minted = mintEmailToken(db, userId, "reset", address.emailFolded, INVITE_TTL_MS, now);
    const queued = send(
      address.email,
      "invite",
      invitation({
        name: String(user["name"]),
        invitedBy: c.get("caller").name,
        url: `${publicOrigin()}/reset#t=${minted.token}`,
        lifetime: lifetimeText(INVITE_TTL_MS),
      }),
      minted.expiresAt,
    );
    return c.json({ email: address.email, mailQueued: queued, expiresAt: minted.expiresAt });
  });

  app.get("/v1/admin/users", requireAdmin, (c) => {
    const rows = db
      .prepare(
        "SELECT u.id, u.name, u.is_admin, u.created_at, u.disabled_at, " +
          "  (SELECT COUNT(*) FROM user_passwords p WHERE p.user_id = u.id) AS has_password, " +
          "  (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL " +
          "     AND s.expires_at > ?) AS sessions, " +
          "  e.email AS email, e.verified_at AS email_verified_at, " +
          "  (SELECT COUNT(*) FROM password_obligations o WHERE o.user_id = u.id) AS owes_password, " +
          "  (SELECT COUNT(*) FROM machine_owners mo WHERE mo.user_id = u.id) AS machines, " +
          "  ml.max_machines AS machine_limit " +
          // Unpaged on purpose: this grows with people, not with time.
          "FROM users u LEFT JOIN user_emails e ON e.user_id = u.id " +
          "  LEFT JOIN user_machine_limits ml ON ml.user_id = u.id ORDER BY u.created_at ASC",
      )
      .all(Date.now());
    const instanceDefault = instanceMachineLimit(db);
    return c.json({
      users: rows.map((row) => ({
        id: String(row["id"]),
        name: String(row["name"]),
        isAdmin: Number(row["is_admin"]) === 1,
        createdAt: Number(row["created_at"]),
        disabled: row["disabled_at"] !== null,
        email: row["email"] === null ? null : String(row["email"]),
        emailVerified: row["email_verified_at"] !== null,
        /** Created with a temporary password and still holding it. */
        mustChangePassword: Number(row["owes_password"]) > 0,
        hasPassword: Number(row["has_password"]) > 0,
        sessions: Number(row["sessions"]),
        // No keys field: an admin is told nothing about anybody's credentials (Q1.631).
        // machinesOverLimit is arithmetic: quota.ts ranks densely from 0, so the ones over are the newest N - L.
        machines: Number(row["machines"]),
        machineLimit:
          row["machine_limit"] === null
            ? instanceDefault
            : Math.min(Number(row["machine_limit"]), MAX_MACHINES_PER_USER),
        machineLimitSource: row["machine_limit"] === null ? "default" : "override",
        // What clearing the override would land on.
        machineLimitDefault: instanceDefault,
        machinesOverLimit: Math.max(
          0,
          Number(row["machines"]) -
            (row["machine_limit"] === null
              ? instanceDefault
              : Math.min(Number(row["machine_limit"]), MAX_MACHINES_PER_USER)),
        ),
      })),
    });
  });

  // PUT sets and DELETE clears, since 0 and no override mean opposite things; lowering below the count switches off the newest machines.
  const machineLimitAnswer = (userId: string): Record<string, unknown> => {
    const quota = effectiveLimit(db, userId);
    const suspended = overLimitMachines(db, userId, quota.limit);
    return {
      userId,
      maxMachines: quota.limit,
      source: quota.source,
      instanceDefault: quota.instanceDefault,
      owned: machineCount(db, userId),
      suspended,
    };
  };

  app.put("/v1/admin/users/:id/machine-limit", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const userId = c.req.param("id");
    const wanted = body["maxMachines"];
    if (typeof wanted !== "number" || !Number.isInteger(wanted)) {
      return jsonError(c, 400, "bad_request", "maxMachines must be a whole number");
    }
    if (wanted < 0) return jsonError(c, 400, "bad_request", "maxMachines may not be negative");
    if (wanted > MAX_MACHINES_PER_USER) {
      return jsonError(
        c,
        400,
        "bad_request",
        `maxMachines may not exceed ${MAX_MACHINES_PER_USER}, which is the fleet-wide ceiling`,
      );
    }
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    writeMachineLimit(db, userId, wanted, c.get("caller").userId);
    return c.json(machineLimitAnswer(userId));
  });

  // GET answers only whether a key exists; POST mints and retires the previous one, and there is no DELETE.
  app.get("/v1/admin/provisioning-key", requireAdmin, (c) => {
    return c.json({ minted: hasProvisioningKey(db) });
  });

  app.post("/v1/admin/provisioning-key", requireAdmin, (c) => {
    // The one time it is ever returned. Shown once by the screen and stored as a
    // hash, exactly as a one-time password is.
    return c.json({ key: mintProvisioningKey(db, c.get("caller").userId).key }, 201);
  });

  app.delete("/v1/admin/users/:id/machine-limit", requireAdmin, (c) => {
    const userId = c.req.param("id");
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }
    clearMachineLimit(db, userId);
    return c.json(machineLimitAnswer(userId));
  });

  // Every key, with both sides of the fallback; a secret is never returned, not even its length or a masked prefix.
  app.get("/v1/admin/settings", requireAdmin, (c) => {
    // installOrigin rather than publicUrl, so the comparison holds behind a TLS proxy.
    const mailSettings = mailConfigured(db, servesGate ? null : installOrigin(c, trustedProxyHops));
    return c.json({
      settings: SETTING_KEYS.map((key) => {
        const resolved = readSetting(db, key);
        const envName = envNameFor(key);
        const secret = SECRET_SETTING_KEYS.has(key);
        return {
          key,
          secret,
          value: secret ? null : resolved.value,
          set: secret ? resolved.source === "database" : undefined,
          source: resolved.source,
          envName,
          envValue: secret ? undefined : ((process.env[envName] ?? "").trim() || null),
          envSet: (process.env[envName] ?? "").trim().length > 0,
        };
      }),
      mail: {
        configured: mailSettings.configured,
        problems: mailSettings.problems,
        delivery: { ...mailHealth(db), paused: mail?.paused?.() === true },
      },
      registration: registrationMode(db),
      serverTime: Date.now(),
    });
  });

  // set and clear are separate verbs: an empty string is a value here, not a deletion. Values are always strings.
  app.put("/v1/admin/settings", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const set = body["set"];
    const clear = body["clear"];
    const writes: [SettingKey, string][] = [];
    const clears: SettingKey[] = [];

    if (set !== undefined) {
      if (typeof set !== "object" || set === null || Array.isArray(set)) {
        return jsonError(c, 400, "bad_request", "set must be an object of key to string");
      }
      for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
        if (!isSettingKey(key)) return jsonError(c, 400, "unknown_setting", `no such setting: ${key}`);
        if (typeof value !== "string") {
          return jsonError(c, 400, "bad_request", `${key} must be a string`);
        }
        const problem = checkSettingValue(key, value);
        if (problem !== null) return jsonError(c, 400, "bad_request", problem);
        writes.push([key, value]);
      }
    }

    if (clear !== undefined) {
      if (!Array.isArray(clear)) return jsonError(c, 400, "bad_request", "clear must be an array of keys");
      for (const key of clear) {
        if (typeof key !== "string" || !isSettingKey(key)) {
          return jsonError(c, 400, "unknown_setting", `no such setting: ${String(key)}`);
        }
        clears.push(key);
      }
    }

    const caller = c.get("caller");
    const now = Date.now();
    // Validated in full before anything is written, so a body with one bad key
    // leaves the configuration exactly as it was rather than half-applied.
    db.exec("BEGIN");
    try {
      for (const [key, value] of writes) writeSetting(db, key, value, caller.userId, now);
      for (const key of clears) clearSetting(db, key);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    mail?.wake();

    const configured = mailConfigured(db);
    return c.json({
      settings: SETTING_KEYS.map((key) => {
        const resolved = readSetting(db, key);
        const secret = SECRET_SETTING_KEYS.has(key);
        const envName = envNameFor(key);
        return {
          key,
          secret,
          value: secret ? null : resolved.value,
          set: secret ? resolved.source === "database" : undefined,
          source: resolved.source,
          envName,
          envValue: secret ? undefined : ((process.env[envName] ?? "").trim() || null),
          envSet: (process.env[envName] ?? "").trim().length > 0,
        };
      }),
      mail: { configured: configured.configured, problems: configured.problems },
      registration: registrationMode(db),
      serverTime: now,
    });
  });

  // Enqueues and answers 202: a synchronous SMTP send could hold a request for ninety seconds on the process carrying every tunnel.
  app.post("/v1/admin/settings/test", requireAdmin, async (c) => {
    const caller = c.get("caller");
    if (!mailConfigured(db).configured) {
      return jsonError(c, 409, "mail_unconfigured", "set a host, a from address and a public URL first");
    }

    const key = mailTestKey(caller.userId);
    const decision = throttle.check(key);
    if (!decision.allowed) return tooManyAttempts(c, decision.retryAfterSeconds);
    throttle.fail(key);

    const body = await readJsonObject(c);
    const checked = checkEmailAddress(body?.["to"] ?? emailOf(db, caller.userId)?.email);
    if (!checked.ok) return jsonError(c, 400, "bad_request", checked.message);

    const id = mail?.enqueue({
      to: checked.address,
      kind: "test",
      subject: testMessage({ instance: instanceName(), sentBy: caller.name }).subject,
      text: testMessage({ instance: instanceName(), sentBy: caller.name }).text,
      html: testMessage({ instance: instanceName(), sentBy: caller.name }).html,
      notAfter: Date.now() + 10 * 60 * 1000,
    });
    if (id === null || id === undefined) {
      return passwordBusy(c, "too much mail queued right now — try again in a moment");
    }
    mail?.wake();
    return c.json({ id, to: checked.address }, 202);
  });

  // Never returns body: a queued message holds a live one-time link.
  app.get("/v1/admin/mail", requireAdmin, (c) => {
    const limit = boundedInt(c.req.query("limit"), 100, 500);
    const offset = boundedInt(c.req.query("offset"), 0);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM mail_outbox").get()?.["n"] ?? 0);
    const rows = db
      .prepare(
        "SELECT id, to_address, kind, subject, created_at, attempts, next_at, sent_at, failed_at, last_error " +
          "FROM mail_outbox ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
    return c.json({
      total,
      limit,
      offset,
      deliveries: rows.map((row) => ({
        id: String(row["id"]),
        to: String(row["to_address"]),
        kind: String(row["kind"]),
        subject: String(row["subject"]),
        createdAt: Number(row["created_at"]),
        attempts: Number(row["attempts"]),
        nextAt: Number(row["next_at"]),
        sentAt: row["sent_at"] === null ? null : Number(row["sent_at"]),
        failedAt: row["failed_at"] === null ? null : Number(row["failed_at"]),
        error: row["last_error"] === null ? null : String(row["last_error"]),
      })),
    });
  });

  app.post("/v1/admin/mail/:id/retry", requireAdmin, (c) => {
    const id = c.req.param("id");
    const row = db.prepare("SELECT body, not_after FROM mail_outbox WHERE id = ?").get(id);
    if (row === undefined) return jsonError(c, 404, "mail_not_found", "no such message");
    const now = Date.now();
    if (row["body"] === null || Number(row["not_after"]) <= now) {
      return jsonError(c, 409, "mail_expired", "this message has expired and cannot be sent again");
    }
    db.prepare("UPDATE mail_outbox SET next_at = ?, failed_at = NULL, attempts = 0, last_error = NULL WHERE id = ?").run(
      now,
      id,
    );
    mail?.wake();
    return c.json({ queued: true });
  });

  // No route issues a credential for another account, and none under /v1/admin/users/:id touches api_keys except the account delete (Q7.74, Q1.631).

  // Ban somebody; rows are kept. The self-refusal also guarantees an enabled admin remains, so removing it needs a last-admin guard.
  app.post("/v1/admin/users/:id/disable", requireAdmin, (c) => {
    const caller = c.get("caller");
    const userId = c.req.param("id");
    if (userId === caller.userId) {
      return jsonError(c, 409, "cannot_disable_self", "you cannot disable your own account");
    }
    const target = db.prepare("SELECT is_admin, disabled_at FROM users WHERE id = ?").get(userId);
    if (!target) return jsonError(c, 404, "user_not_found", "no such user");
    if (target["disabled_at"] !== null) {
      return jsonError(c, 404, "user_not_found", "no such user, or already disabled");
    }

    const now = Date.now();
    // One transaction: a partial ban would leave codes live, and the already-disabled guard stops any retry from burning them.
    db.exec("BEGIN");
    let revoked = 0;
    let codesInvalidated = 0;
    let tokensInvalidated = 0;
    try {
      const changed = db
        .prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL")
        .run(now, userId);
      if (changed.changes !== 1) {
        db.exec("ROLLBACK");
        return jsonError(c, 404, "user_not_found", "no such user, or already disabled");
      }

      revoked = revokeAllSessions(db, userId, null, now);
      // Unredeemed codes are the one credential a ban does not otherwise reach: /v1/enroll never asks who minted them.
      codesInvalidated = burnUserCodes(db, userId, "user_disabled", now);
      // And codes an admin minted for machines they hold a grant on, which created_by cannot see.
      codesInvalidated += burnGranteeCodes(db, userId, "user_disabled", now);
      // And live reset links: /v1/reset has no caller either.
      tokensInvalidated = burnEmailTokens(db, userId, "user_disabled", now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // Immediate for new tokens; tokens already issued live until they expire.
    return c.json({
      disabled: true,
      sessionsRevoked: revoked,
      emailLinksInvalidated: tokensInvalidated,
      enrollmentCodesInvalidated: codesInvalidated,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  app.post("/v1/admin/users/:id/enable", requireAdmin, (c) => {
    const changed = db
      .prepare("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL")
      .run(c.req.param("id"));
    if (changed.changes !== 1) return jsonError(c, 404, "user_not_found", "no such user, or not disabled");
    // Sessions and enrollment codes that disable burned stay burned.
    return c.json({ disabled: false });
  });

  // Delete a person and every credential; their machines are revoked, since no non-revoked machine may be ownerless.
  // enrollment_codes.created_by is left dangling on purpose as the audit trail. Disable is the reversible act.
  app.delete("/v1/admin/users/:id", requireAdmin, (c) => {
    const caller = c.get("caller");
    const userId = c.req.param("id");
    if (userId === caller.userId) {
      return jsonError(c, 409, "cannot_delete_self", "you cannot delete your own account");
    }
    const target = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
    if (!target) return jsonError(c, 404, "user_not_found", "no such user");

    const removedAt = Date.now();
    db.exec("BEGIN");
    let machinesRevoked = 0;
    let codesInvalidated = 0;
    try {
      // Origins first: they are keyed by session id, so removing the sessions
      // ahead of them would leave rows only the orphan sweep could find.
      db.prepare(
        "DELETE FROM user_session_origins WHERE session_id IN (SELECT id FROM user_sessions WHERE user_id = ?)",
      ).run(userId);
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_passwords WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
      // Before the grants go: burnGranteeCodes finds its codes through them.
      codesInvalidated = burnGranteeCodes(db, userId, "user_deleted", removedAt);
      // Read before the grants go: a machine left with no owner and no grants would stay enrolled and in nobody's list.
      const mayStrand = db
        .prepare(
          "SELECT g.machine_id FROM grants g JOIN machines m ON m.id = g.machine_id " +
            "WHERE g.user_id = ? AND m.revoked_at IS NULL " +
            "AND NOT EXISTS (SELECT 1 FROM machine_owners o WHERE o.machine_id = g.machine_id)",
        )
        .all(userId)
        .map((row) => String(row["machine_id"]));
      db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
      for (const machineId of mayStrand) {
        const stillGranted = db.prepare("SELECT 1 AS hit FROM grants WHERE machine_id = ? LIMIT 1").get(machineId);
        if (stillGranted !== undefined) continue;
        const marked = Number(
          db
            .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .run(removedAt, machineId).changes,
        );
        if (marked === 1) {
          codesInvalidated += burnMachineCodes(db, machineId, removedAt);
          machinesRevoked += 1;
        }
      }
      // foreign_keys is off, so nothing cascades: a new per-user table must be swept here.
      deleteEmailState(db, userId);
      db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_machine_limits WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM devices WHERE user_id = ?").run(userId);
      codesInvalidated += burnUserCodes(db, userId, "user_deleted", removedAt);
      for (const row of db
        .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ?")
        .all(userId)) {
        const machineId = String(row["machine_id"]);
        const marked = Number(
          db
            .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .run(removedAt, machineId).changes,
        );
        if (marked === 1) {
          codesInvalidated += burnMachineCodes(db, machineId, removedAt);
          machinesRevoked += 1;
        }
      }
      db.prepare("DELETE FROM machine_owners WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json({
      deleted: true,
      name: String(target["name"]),
      machinesRevoked,
      enrollmentCodesInvalidated: codesInvalidated,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  // Register a machine for somebody, as install.sh's wizard does; ownerId is required so no non-revoked machine is ownerless.
  app.post("/v1/admin/machines", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return jsonError(c, 400, "bad_request", "name is required and must be at most 200 characters");
    }
    const ownerId = body["ownerId"];
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return jsonError(
        c,
        400,
        "bad_request",
        "ownerId is required — a machine with no owner is outside the machine limit and outside the ban check",
      );
    }

    {
      if (!db.prepare("SELECT id FROM users WHERE id = ?").get(ownerId)) {
        return jsonError(c, 404, "user_not_found", "no such user");
      }
      const named = readLabel(name);
      if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
      // The wider clash check every creation path makes: the unique index misses shared and legacy names, and case.
      if (nameVisibleTo(db, ownerId, named.label)) {
        return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
      }
      const quota = effectiveLimit(db, ownerId);
      const created = createOwnedMachine(db, ownerId, named.label, ALL_SCOPES, quota.limit);
      if ("error" in created) {
        if (created.error === "too_many") {
          return jsonError(
            c,
            409,
            "machine_limit",
            `that user's machine limit is ${quota.limit} and they own ${machineCount(db, ownerId)} — ` +
              "raise their limit first",
          );
        }
        return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
      }
      return c.json(adminMachine({ id: created.id, name: created.name, enrolled_at: null, revoked_at: null }), 201);
    }
  });

  // Rename a machine. machines.name is globally unique, but only nameVisibleToGrantees sees a name its grantees already use.
  app.patch("/v1/admin/machines/:id", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");

    const machineId = c.req.param("id");
    const machine = db
      .prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ? OR name = ?")
      .get(machineId, machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    let name = String(machine["name"]);
    if ("name" in body) {
      const raw = body["name"];
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 200) {
        return jsonError(c, 400, "bad_request", "name must be a non-empty string of at most 200 characters");
      }
      name = raw.trim();
      const clash = db.prepare("SELECT id FROM machines WHERE name = ? AND id != ?").get(name, String(machine["id"]));
      if (clash) return jsonError(c, 409, "machine_exists", "a machine with that name already exists");
      if (nameVisibleToGrantees(db, String(machine["id"]), name)) {
        return jsonError(c, 409, "machine_exists", "somebody who can reach this machine already sees one with that name");
      }
    }

    db.prepare("UPDATE machines SET name = ? WHERE id = ?").run(name, String(machine["id"]));

    // Renaming never re-enrolls: the daemon must not be made to fetch anything again.
    return c.json(
      adminMachine({
        id: String(machine["id"]),
        name,
        enrolled_at: machine["enrolled_at"],
        revoked_at: machine["revoked_at"],
      }),
    );
  });

  app.get("/v1/admin/machines", requireAdmin, (c) => {
    const rows = db
      .prepare("SELECT id, name, enrolled_at, revoked_at FROM machines ORDER BY created_at ASC")
      .all();
    // Built once: adminMachine per row would be N+1 over the whole fleet.
    const overLimit = overLimitMachineIds(db);
    const owners = new Map<string, { userId: string; label: string }>();
    for (const row of db.prepare("SELECT machine_id, user_id, label FROM machine_owners").all()) {
      owners.set(String(row["machine_id"]), { userId: String(row["user_id"]), label: String(row["label"]) });
    }
    return c.json({
      machines: rows.map((row) =>
        adminMachineProjection(
          row,
          relayUrlFor,
          relayOnline,
          (id) => overLimit.has(id),
          (id) => owners.get(id) ?? null,
          lastSeenAt,
        ),
      ),
    });
  });

  app.get("/v1/admin/relay", requireAdmin, (c) => {
    const tunnels = relay === null ? [] : relay.stats();
    // Relay ids holding tunnels but missing from the routing map; empty when no map is configured.
    const unmapped =
      relayUrls === null
        ? []
        : [...new Set(tunnels.map((tunnel) => tunnel.relayId))].filter((id) => !Object.hasOwn(relayUrls, id)).sort();
    return c.json({
      enabled: relay !== null,
      url: relayUrl,
      relayUrls,
      unmapped,
      tunnels,
    });
  });

  // Build inventory off the tunnel handshake, not a daemon request (Q1.9); offline machines are included on purpose.
  app.get("/v1/admin/fleet", requireAdmin, (c) => {
    const rows = db
      .prepare(
        `SELECT m.id, m.name, m.daemon_version, m.daemon_protocol, m.daemon_agents, m.daemon_seen_at, m.revoked_at,
                mo.label AS label
           FROM machines m
           LEFT JOIN machine_owners mo ON mo.machine_id = m.id
          ORDER BY m.name`,
      )
      .all();

    const machines = rows.map((row) => ({
      id: String(row["id"]),
      name: String(row["name"]),
      label: typeof row["label"] === "string" ? row["label"] : null,
      revoked: row["revoked_at"] !== null,
      version: typeof row["daemon_version"] === "string" ? row["daemon_version"] : null,
      protocol: typeof row["daemon_protocol"] === "number" ? row["daemon_protocol"] : null,
      agents: typeof row["daemon_agents"] === "string" ? parseAgentClis(row["daemon_agents"]) : null,
      seenAt: typeof row["daemon_seen_at"] === "number" ? row["daemon_seen_at"] : null,
    }));

    const byProtocol: Record<string, number> = {};
    for (const machine of machines) {
      if (machine.revoked) continue;
      const key = machine.protocol === null ? "unknown" : String(machine.protocol);
      byProtocol[key] = (byProtocol[key] ?? 0) + 1;
    }

    return c.json({
      relay: { protocol: RELAY_PROTOCOL_VERSION, oldestAccepted: RELAY_PROTOCOL_MIN_VERSION },
      controlPlane: { version: VERSION },
      byProtocol,
      machines,
    });
  });

  app.get("/v1/admin/signing-keys", requireAdmin, (c) =>
    // Inventory only, never key material; the public halves are on /v1/jwks.
    c.json({ keys: signingKeyRows(db) }),
  );

  // The old key stays active: daemons hold the key set from enrollment, so retiring is a separate, later act.
  app.post("/v1/admin/signing-keys", requireAdmin, (c) => {
    const minted = mintSigningKey(db);
    return c.json({ kid: minted.kid, active: signingKeyRows(db).filter((row) => row.retiredAt === null).length }, 201);
  });

  // Refuses the last active key: with none, nothing can be signed and nothing mints a replacement until a restart.
  app.delete("/v1/admin/signing-keys/:kid", requireAdmin, (c) => {
    const result = retireSigningKey(db, c.req.param("kid"));
    if (result.ok) return c.json({ retired: true });
    if (result.reason === "not_found") {
      return jsonError(c, 404, "key_not_found", "no such active signing key");
    }
    return jsonError(
      c,
      409,
      "last_active",
      "this is the only active signing key; mint another before retiring it",
    );
  });

  // Mint an enrollment code; re-enrolling is redeeming a newer one, so this is also the key-rotation path.
  app.post("/v1/admin/machines/:id/enrollments", requireAdmin, (c) => {
    const machineId = c.req.param("id");
    const machine = db.prepare("SELECT id, revoked_at, enrolled_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    // Refused for an enrolled machine somebody depends on: redeeming retires its tunnel credential and takes over their daemon's traffic.
    const enrollDependants = dependants(machineId);
    if (
      machine["enrolled_at"] !== null &&
      (enrollDependants.owner !== null || enrollDependants.grantees.length > 0)
    ) {
      return jsonError(
        c,
        409,
        "machine_enrolled",
        "this machine is enrolled and somebody depends on it; redeeming a new code would take it away " +
          "from their daemon, so its owner mints their own from POST /v1/machines/:id/enrollments",
      );
    }

    // Refused over somebody else's live code: minting supersedes it and silently breaks their install.
    const outstanding = db
      .prepare(
        "SELECT created_by FROM enrollment_codes WHERE machine_id = ? AND used_at IS NULL AND expires_at > ?",
      )
      .get(machineId, Date.now());
    if (outstanding !== undefined && String(outstanding["created_by"]) !== c.get("caller").userId) {
      return jsonError(
        c,
        409,
        "code_outstanding",
        "somebody else minted a code for this machine and it has not been used yet; minting here would " +
          "kill it silently, so wait for it to expire or have its owner mint their own",
      );
    }

    ensureSigningKey(db);

    // The same minter the owner's route uses, so "one live code per machine"
    // cannot be true on one path and false on the other.
    const minted = mintEnrollmentCode(db, machineId, c.get("caller").userId, ENROLLMENT_CODE_TTL_MS);

    // Shown once. Only the hash was stored, so this cannot be recovered later.
    return c.json(
      { code: minted.code, machineId, expiresAt: minted.expiresAt, controlPlaneUrl: installOrigin(c, trustedProxyHops) },
      201,
    );
  });

  // Forget a machine's pinned encryption key so its next dial pins the one it announces; it is unreachable until then.
  // previousKey is returned because nothing else ever reports what was pinned.
  app.delete("/v1/admin/machines/:id/machine-key", requireAdmin, (c) => {
    const machineId = c.req.param("id");
    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }

    const previousKey = machineKeyFor(db, machineId);
    db.prepare("UPDATE machines SET machine_key = NULL, machine_key_set_at = NULL WHERE id = ?").run(machineId);

    return c.json({ machineId, cleared: previousKey !== null, previousKey });
  });

  app.post("/v1/admin/machines/:id/revoke", requireAdmin, (c) => {
    const machineId = c.req.param("id");
    const now = Date.now();
    let changed = 0;
    let burned = 0;
    // No return or await between BEGIN and COMMIT: the shared connection would stay inside the transaction.
    db.exec("BEGIN");
    try {
      changed = Number(
        db
          .prepare("UPDATE machines SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(now, machineId).changes,
      );
      if (changed === 1) {
        burned = burnMachineCodes(db, machineId, now);
        releaseOwner(db, machineId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (changed !== 1) {
      return jsonError(c, 404, "machine_not_found", "no such machine, or already revoked");
    }

    return c.json({
      revoked: true,
      enrollmentCodesInvalidated: burned,
      outstandingTokensExpireWithinSeconds: tokenTtlSeconds,
    });
  });

  // Give an ownerless machine an owner, or re-label it for the one it has; the all-scopes grant is written with the ownership row.
  app.put("/v1/admin/machines/:id/owner", requireAdmin, async (c) => {
    const body = await readJsonObject(c);
    if (!body) return jsonError(c, 400, "bad_request", "expected a JSON object body");
    const machineId = c.req.param("id");
    const userId = body["userId"];
    if (typeof userId !== "string" || userId.length === 0) {
      return jsonError(c, 400, "bad_request", "userId is required");
    }
    const named = readLabel(body["label"]);
    if (!named.ok) return jsonError(c, 400, "bad_request", named.message);
    const label = named.label;

    const machine = db.prepare("SELECT id, revoked_at FROM machines WHERE id = ?").get(machineId);
    if (!machine) return jsonError(c, 404, "machine_not_found", "no such machine");
    if (machine["revoked_at"] !== null) {
      return jsonError(c, 403, "machine_revoked", "this machine has been revoked");
    }
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) {
      return jsonError(c, 404, "user_not_found", "no such user");
    }

    // A machine with a live owner may only go back to that owner: a transfer would be full authority in one admin request.
    const { owner: existingOwner, grantees } = dependants(machineId);
    if (existingOwner !== null && existingOwner.userId !== userId) {
      return jsonError(
        c,
        403,
        "machine_owned",
        "this machine has an owner; ownership is theirs to release, and sharing it is theirs to grant",
      );
    }
    // An ownerless machine with grantees may only be adopted to one of them, or this is the deleted admin grant escalation.
    if (existingOwner === null && grantees.length > 0 && !grantees.includes(userId)) {
      return jsonError(
        c,
        403,
        "machine_granted",
        "this machine has no owner but somebody holds a grant on it; adopt it to one of them, " +
          "who then shares it from PUT /v1/machines/:id/grants",
      );
    }

    // Other machines only, so re-labelling one they already own is never refused.
    const owned = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ? AND machine_id != ?")
        .get(userId, machineId)?.["n"] ?? 0,
    );
    const ceiling = Math.min(effectiveLimit(db, userId).limit, MAX_MACHINES_PER_USER);
    if (owned >= ceiling) {
      return jsonError(
        c,
        409,
        "machine_limit",
        `that user's machine limit is ${ceiling} and they already own ${owned} — raise their limit first`,
      );
    }

    // nameVisibleTo only sees granted machines, so the (user_id, label) index is asked directly: a 409 rather than a 500.
    if (nameVisibleTo(db, userId, label, machineId)) {
      return jsonError(c, 409, "machine_exists", "that user can already see a machine with that name");
    }
    if (
      db
        .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ? AND label = ? AND machine_id != ?")
        .get(userId, label, machineId)
    ) {
      return jsonError(c, 409, "machine_exists", "that user already has a machine with that name");
    }

    const now = Date.now();
    let codesInvalidated = 0;
    // A transfer is a fresh acquisition (the first over the limit); a re-label keeps its time. Read before releaseOwner destroys it.
    const previous = db.prepare("SELECT user_id, created_at FROM machine_owners WHERE machine_id = ?").get(machineId);
    const isAcquisition = !(previous !== undefined && String(previous["user_id"]) === userId);
    const acquiredAt = isAcquisition ? now : Number(previous["created_at"]);
    db.exec("BEGIN");
    try {
      // Replace rather than upsert: `machine_owners` is keyed on the machine, so
      // handing it to somebody else is one row out and one row in.
      releaseOwner(db, machineId);
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        userId,
        label,
        acquiredAt,
      );
      db.prepare(
        "INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id, machine_id) DO UPDATE SET scopes = excluded.scopes",
      ).run(userId, machineId, ALL_SCOPES.join(" "), now);
      // Burn outstanding codes: the mint guard does not stop redeeming a code kept from before the adoption.
      // Only on an acquisition: burning on a re-label would kill the owner's in-flight code.
      if (isAcquisition) codesInvalidated = burnMachineCodes(db, machineId, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return c.json({ machineId, userId, label, scopes: [...ALL_SCOPES], enrollmentCodesInvalidated: codesInvalidated });
  });

  // No route under /v1/admin adds or widens a grant on an owned machine for anyone but its owner (Q1.11).

  // Paged: grants grow with users times machines.
  app.get("/v1/admin/grants", requireAdmin, (c) => {
    const limit = boundedInt(c.req.query("limit"), DEFAULT_GRANT_PAGE, MAX_GRANT_PAGE);
    const offset = boundedInt(c.req.query("offset"), 0, Number.MAX_SAFE_INTEGER);
    const total = Number(db.prepare("SELECT COUNT(*) AS n FROM grants").get()?.["n"] ?? 0);
    const rows = db
      .prepare("SELECT user_id, machine_id, scopes FROM grants ORDER BY created_at ASC, user_id ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
    return c.json({
      grants: rows.map((row) => ({
        userId: String(row["user_id"]),
        machineId: String(row["machine_id"]),
        scopes: parseScopes(String(row["scopes"])),
      })),
      total,
      limit,
      offset,
    });
  });

  // GET /install.sh: deploy/bootstrap.sh with this instance's origin shell-quoted in, since the origin comes from Host.
  // split and join, never replace (Host may carry $&); no-store because the body varies by Host.
  const bootstrapScript = options.bootstrapScript ?? null;
  if (bootstrapScript !== null) {
    app.get("/install.sh", async (c) => {
      let template: string;
      try {
        // Read per request and asynchronously: deploy.sh moves the checkout, and a sync read would block every tunnel.
        template = await readFile(bootstrapScript, "utf8");
      } catch {
        // A missing file is a legal deployment, not a 500.
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      const origin = installOrigin(c, trustedProxyHops);
      const parts = template.split(INSTALL_PLACEHOLDER);
      // Refuse rather than ship an installer with no origin or with other than one placeholder.
      if (origin === "" || parts.length !== 2) {
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      return c.body(parts.join(shellQuote(origin)), 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    });
  }

  // A browser is served only the gate bundle (dist-gate), never the app.
  if (servesGate) {
    app.use("*", serveStatic({ root: gateRoot, precompressed: true }));

    // The gate's fallback over a closed list of paths; anything else, including every app address, gets the error envelope.
    const serveGate = serveStatic<AppEnv>({ root: gateRoot, path: "gate.html" });
    const GATE_PATHS = new Set(
      [...GATE_SCREEN_PATHS, ...LEGAL_DOC_PATHS, APP_HANDOFF_PATH].map((name) => `/${name}`),
    );

    app.get("*", async (c) => {
      const path = c.req.path;
      if (!GATE_PATHS.has(path)) {
        return jsonError(c, 404, "not_found", "no such endpoint");
      }
      return serveGate(c, async () => undefined);
    });
  }

  // Every unmatched path, any method, answers in the error envelope; notFound cannot shadow a route.
  app.notFound((c) => jsonError(c, 404, "not_found", "no such endpoint"));

  return app;
}

// One shape for a machine wherever an admin route returns one.
function adminMachineProjection(
  row: Record<string, unknown>,
  relayUrlFor: (machineId: string) => string | null,
  online: (machineId: string) => boolean,
  overLimit: (machineId: string) => boolean,
  ownerFor: (machineId: string) => { userId: string; label: string } | null,
  /** When the machine was last connected, or null if no tunnel was ever recorded (never zero). */
  lastSeen: (machineId: string) => number | null,
): Record<string, unknown> {
  const id = String(row["id"]);
  return {
    id,
    name: String(row["name"]),
    enrolled: row["enrolled_at"] !== null && row["enrolled_at"] !== undefined,
    revoked: row["revoked_at"] !== null && row["revoked_at"] !== undefined,
    relayUrl: relayUrlFor(id),
    relayOnline: online(id),
    overLimit: overLimit(id),
    owner: ownerFor(id),
    lastSeenAt: lastSeen(id),
  };
}

// Resolves an API key or session token to a caller; the prefix picks the table, and a disabled user fails on every request.
function callerAuth(db: DatabaseSync): MiddlewareHandler<AppEnv> {
  // Prepared once here: this runs on every authenticated request.
  const keyByPrefix = db.prepare(
    "SELECT k.id AS key_id, k.key_hash, k.revoked_at, k.last_used_at, u.id, u.name, u.is_admin, u.disabled_at " +
      "FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.prefix = ?",
  );
  // At most one write a minute per key, and guarded: nothing decides on this column, so a busy database must not fail the request.
  const touchKey = db.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)",
  );
  const userById = db.prepare("SELECT id, name, is_admin, disabled_at FROM users WHERE id = ?");

  return async (c, next) => {
    const presented = bearerToken(c.req.header("authorization"));
    if (presented === null || presented.length === 0) {
      return jsonError(c, 401, "missing_api_key", "missing API key");
    }

    if (presented.startsWith(SESSION_PREFIX)) {
      const resolved = resolveSession(db, presented);
      if (!resolved.ok) {
        // Reported apart, which is safe because reaching here took a real token; expired means offer sign-in again.
        if (resolved.reason === "revoked") {
          return jsonError(c, 401, "session_revoked", "this session has been signed out");
        }
        if (resolved.reason === "expired") {
          return jsonError(c, 401, "session_expired", "this session has expired — sign in again");
        }
        // Kept apart from session_revoked: the client must also give up its stored device id.
        if (resolved.reason === "device_revoked") {
          return jsonError(c, 401, "device_revoked", "this device has been signed out and retired");
        }
        return jsonError(c, 401, "invalid_api_key", "invalid API key");
      }

      const user = userById.get(resolved.session.userId);
      // Reported as an invalid credential: the caller may not learn the user is gone.
      if (!user) return jsonError(c, 401, "invalid_api_key", "invalid API key");
      if (user["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this user has been disabled");
      }

      touchSession(db, resolved.session.id);
      c.set("caller", {
        userId: String(user["id"]),
        name: String(user["name"]),
        isAdmin: Number(user["is_admin"]) === 1,
        via: "session",
        sessionId: resolved.session.id,
        deviceId: resolved.session.deviceId,
      });
      return next();
    }

    if (!presented.startsWith(API_KEY_PREFIX)) {
      // Neither shape, so there is nothing to look up. Refused without touching
      // the database, and with the same answer a wrong key gets.
      return jsonError(c, 401, "invalid_api_key", "invalid API key");
    }

    const rows = keyByPrefix.all(keyPrefix(presented));

    for (const row of rows) {
      if (!credentialMatches(presented, String(row["key_hash"]))) continue;
      if (row["revoked_at"] !== null) {
        return jsonError(c, 401, "api_key_revoked", "this API key has been revoked");
      }
      if (row["disabled_at"] !== null) {
        return jsonError(c, 403, "user_disabled", "this user has been disabled");
      }
      const usedAt = row["last_used_at"] === null ? null : Number(row["last_used_at"]);
      const at = Date.now();
      if (usedAt === null || at - usedAt >= KEY_TOUCH_INTERVAL_MS) {
        try {
          touchKey.run(at, String(row["key_id"]), at - KEY_TOUCH_INTERVAL_MS);
        } catch {
          // Bookkeeping only: a busy database must not turn a valid request into a 500.
        }
      }
      c.set("caller", {
        userId: String(row["id"]),
        name: String(row["name"]),
        isAdmin: Number(row["is_admin"]) === 1,
        via: "api_key",
        sessionId: null,
        // No session, therefore no device. Said here rather than left to the
        // type, because it is also why `POST /v1/me/devices` refuses a key.
        deviceId: null,
      });
      return next();
    }
    return jsonError(c, 401, "invalid_api_key", "invalid API key");
  };
}

// Prepared once per database: this runs on every request below THE SECOND LINE.
const obligationStatements = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();

function obligationOf(db: DatabaseSync, userId: string): string | null {
  let statement = obligationStatements.get(db);
  if (statement === undefined) {
    statement = db.prepare("SELECT reason FROM password_obligations WHERE user_id = ?");
    obligationStatements.set(db, statement);
  }
  const row = statement.get(userId);
  return row === undefined ? null : String(row["reason"]);
}

// THE SECOND LINE's middleware; ignores caller.via, since the obligation belongs to the account.
function requirePasswordCurrent(db: DatabaseSync): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reason = obligationOf(db, c.get("caller").userId);
    if (reason !== null) {
      return jsonError(
        c,
        403,
        "password_change_required",
        "set a new password before using this account",
        { reason },
      );
    }
    return next();
  };
}

// PasswordBusyError as a 503; Retry-After is what makes it a refusal that expires.
function passwordBusy(c: Context, message = "too busy to hash a password right now — try again in a moment"): Response {
  c.header("Retry-After", "1");
  return jsonError(c, 503, "overloaded", message);
}

// Retry-After must agree with the body's retryAfterSeconds.
function tooManyAttempts(c: Context, retryAfterSeconds: number, message = "too many attempts — wait and try again"): Response {
  c.header("Retry-After", String(retryAfterSeconds));
  return jsonError(c, 429, "too_many_attempts", message, { retryAfterSeconds });
}

// 413 in the error envelope; pass it to every bodyLimit, whose default answers plain text.
function payloadTooLarge(c: Context): Response {
  return jsonError(c, 413, "payload_too_large", "that request body is too large");
}

// One label reader for every route: labelIsWellFormed decides, and MACHINE_LABEL_RESERVED only picks the message.
function readLabel(raw: unknown): { ok: true; label: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: MACHINE_LABEL_HELP };
  const label = raw.trim();
  if (MACHINE_LABEL_RESERVED.test(label)) return { ok: false, message: MACHINE_LABEL_RESERVED_HELP };
  if (!labelIsWellFormed(label)) return { ok: false, message: MACHINE_LABEL_HELP };
  return { ok: true, label };
}

// Never key_hash; revoked rows are listed rather than filtered, so a leaked key can be seen dead.
function apiKeyRows(db: DatabaseSync, userId: string): Record<string, unknown>[] {
  return db
    .prepare("SELECT id, prefix, created_at, revoked_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId)
    .map((row) => ({
      id: String(row["id"]),
      prefix: String(row["prefix"]),
      createdAt: Number(row["created_at"]),
      revokedAt: row["revoked_at"] === null ? null : Number(row["revoked_at"]),
      lastUsedAt: row["last_used_at"] === null ? null : Number(row["last_used_at"]),
    }));
}

/** How stale last_used_at may get before a request writes it; exported for relaycheck. */
export const KEY_TOUCH_INTERVAL_MS = 60_000;

function passwordChangedAt(db: DatabaseSync, userId: string): number | null {
  const row = db.prepare("SELECT password_changed_at FROM users WHERE id = ?").get(userId);
  const value = row?.["password_changed_at"];
  return value === null || value === undefined ? null : Number(value);
}

// Called only where the person chooses a password (me/password and reset), never for an admin or rehash write.
function markPasswordChanged(db: DatabaseSync, userId: string, now: number): void {
  db.prepare("UPDATE users SET password_changed_at = ? WHERE id = ?").run(now, userId);
}

// false when unknown, revoked or somebody else's; user_id in the WHERE confines it to the caller's own keys.
function revokeApiKey(db: DatabaseSync, userId: string, keyId: string, now = Date.now()): boolean {
  const changed = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(now, keyId, userId);
  return Number(changed.changes) === 1;
}

function parseScopes(value: string): Scope[] {
  return value
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .filter((entry): entry is Scope => (ALL_SCOPES as readonly string[]).includes(entry));
}

/** `null` on anything that is not an array of known scopes. */
function readScopes(value: unknown): Scope[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Scope[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    if (!(ALL_SCOPES as readonly string[]).includes(entry)) return null;
    if (!out.includes(entry as Scope)) out.push(entry as Scope);
  }
  return out;
}

// Pinned, not configured: the catalogue pins a GitHub commit, and this is the host that serves one.
const PLUGIN_MANIFEST_ORIGIN = "https://raw.githubusercontent.com";

function originOf(url: string | null): string | null {
  if (url === null || url.length === 0) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function connectOrigins(relayUrl: string | null, relayUrls: Record<string, string> | null): string {
  const sources = new Set<string>();
  // Every relay, as its origin and its ws or wss form: CSP matches the scheme, and a token may name any relay.
  for (const candidate of [relayUrl, ...Object.values(relayUrls ?? {})]) {
    if (candidate === null || candidate.length === 0) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const socket = parsed.protocol === "http:" ? "ws:" : "wss:";
    sources.add(parsed.origin);
    sources.add(`${socket}//${parsed.host}`);
  }
  return sources.size === 0 ? "" : ` ${[...sources].join(" ")}`;
}

// deploycheck counts this token in deploy/bootstrap.sh.
const INSTALL_PLACEHOLDER = "@REEMOAT_CONTROL_PLANE@";

// The third copy (web enrollment.ts, cpctl.ts); webcheck extracts this top-level body and runs all three over hostile URLs.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// publicUrl corrected by x-forwarded-proto within trustedHops: behind a TLS proxy (Traefik, passHostHeader) publicUrl says http.
function installOrigin(c: Context, trustedHops: number): string {
  const base = publicUrl(c);
  if (base === "" || trustedHops <= 0) return base;
  // The entry trustedHops from the right, as callerAddressOf reads x-forwarded-for: the leftmost is the client's own claim.
  const entries = (c.req.header("x-forwarded-proto") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length < trustedHops) return base;
  const forwarded = entries[entries.length - trustedHops] ?? "";
  if (forwarded !== "https" && forwarded !== "http") return base;
  return base.replace(/^https?:/, `${forwarded}:`);
}

function publicUrl(c: Context): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

