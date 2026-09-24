#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createControlPlaneApp, drainDeferred, DEFAULT_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS } from "./app.js";
import { pruneDevices } from "./devices.js";
import { pruneEmailTokens } from "./emails.js";
import { ensureSigningKey, newApiKey, newId, pruneEnrollmentCodes } from "./keys.js";
import { pruneMailOutbox, startMailPump } from "./mail/outbox.js";
import { DEFAULT_TRUSTED_PROXY_HOPS, forwardingIgnored } from "./net.js";
import { socketDialer } from "./mail/smtp.js";
import { checkPasswordPolicy, generatePassword, hashPassword } from "./password.js";
import { pruneRegistrations } from "./registration.js";
import { mailConfigured, readSetting, registrationMode } from "./settings.js";
import { pruneSessions } from "./sessions.js";
import { createRelayListener } from "./relay/listener.js";
import { isBrowserReachable, parseRelayUrls } from "./relay/routing.js";
import { DEFAULT_RELAY_ID, dbRelayView } from "./relay/presence.js";
import { TunnelRegistry, type RelayView } from "./relay/registry.js";
import { openControlStore, type ControlStore } from "./store.js";
import { describeError } from "../../../src/http.js";

// Fallback only: libuv reads this at its first pool use, so the Dockerfile and launch scripts set it before node starts.
process.env["UV_THREADPOOL_SIZE"] ??= "64";

function threadpoolNote(): string {
  const configured = (process.env["UV_THREADPOOL_SIZE"] ?? "").trim();
  const size = Number(configured);
  if (Number.isInteger(size) && size > 0) return `threadpool: ${size}`;
  return (
    "threadpool: 4 (default) — UV_THREADPOOL_SIZE is unset.\n" +
    "  Password hashing and the web bundle share those 4 slots."
  );
}

const DEFAULT_PORT = 7888;
const DEFAULT_RELAY_PORT = 7889;
const DEFAULT_RELAY_HOST = "0.0.0.0";
/** Loopback by default: this service holds the key that signs every token in the fleet. */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DB = join(homedir(), ".reemoat", "control-plane.db");
const DEFAULT_ISSUER = "reemoat-cp";

const port = Number.parseInt(process.env["REEMOAT_CP_PORT"] ?? String(DEFAULT_PORT), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`REEMOAT_CP_PORT must be a valid port, got "${process.env["REEMOAT_CP_PORT"]}"`);
  process.exit(2);
}
const host = process.env["REEMOAT_CP_HOST"] ?? DEFAULT_HOST;

const relayUrl = (process.env["REEMOAT_CP_RELAY_URL"] ?? "").trim();
if (relayUrl.length === 0) {
  console.error(
    "REEMOAT_CP_RELAY_URL is required.\n" +
      "  Every daemon dials it and every request to a machine goes through it, so a\n" +
      "  control plane without one is a fleet nobody can reach. Set it to the origin\n" +
      "  daemons and browsers see this service at, e.g. https://relay.example",
  );
  process.exit(2);
}
if (!isBrowserReachable(relayUrl)) {
  console.error(
    `REEMOAT_CP_RELAY_URL must be an absolute http:// or https:// URL, got "${relayUrl}".\n` +
      "  Browsers reach machines through this, and they need a scheme fetch() accepts:\n" +
      "  `machine.ts` probes it with fetch(new URL(\"/health\", base)) and derives the\n" +
      "  WebSocket URL itself — https becomes wss, and **anything else becomes plain ws**.\n" +
      "  So a wss:// value here does not merely fail the probe, it downgrades the stream.\n" +
      "  e.g. https://relay.example",
  );
  process.exit(2);
}

const relayMode = (process.env["REEMOAT_CP_RELAY_MODE"] ?? "embedded").trim() || "embedded";
if (relayMode !== "embedded" && relayMode !== "external") {
  console.error(
    `REEMOAT_CP_RELAY_MODE must be "embedded" or "external", got "${relayMode}".\n` +
      "  embedded: this process holds the tunnels (the default, and what `pnpm cp` runs).\n" +
      "  external: a separate relay process does, and this one reads presence from the database.",
  );
  process.exit(2);
}
const relayEmbedded = relayMode === "embedded";

// Refused rather than defaulted: a wrong hop count collapses every caller into one throttle bucket. See net.ts.
const trustedProxyHops = Number.parseInt(
  process.env["REEMOAT_CP_TRUSTED_PROXY_HOPS"] ?? String(DEFAULT_TRUSTED_PROXY_HOPS),
  10,
);
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 8) {
  console.error(
    `REEMOAT_CP_TRUSTED_PROXY_HOPS must be an integer from 0 to 8, got ` +
      `"${process.env["REEMOAT_CP_TRUSTED_PROXY_HOPS"]}".\n` +
      "  0 (the default): no proxy in front — ignore x-forwarded-for and use the socket.\n" +
      "  1: one reverse proxy of your own, which is what publishing on 127.0.0.1 behind\n" +
      "     TLS means. 2 would be that proxy behind a CDN. Entries are counted from the\n" +
      "     right, so this is how many hops you control rather than how many exist.",
  );
  process.exit(2);
}

// Where a browser reaches each relay (https, never wss); REEMOAT_CP_RELAY_URL stays the one name daemons dial.
const relayUrls = parseRelayUrls(process.env["REEMOAT_CP_RELAY_URLS"]);
if (relayUrls === "invalid") {
  console.error(
    `REEMOAT_CP_RELAY_URLS must be a comma-separated list of <relay-id>=<absolute url>, got ` +
      `"${process.env["REEMOAT_CP_RELAY_URLS"]}".\n` +
      "  Each id is a relay's REEMOAT_CP_RELAY_ID and each url is where a *browser*\n" +
      "  reaches that relay — http:// or https://, never ws:// or wss://, because the\n" +
      "  client derives the WebSocket scheme itself. e.g.\n" +
      "  relay-1=https://r1.example,relay-2=https://r2.example\n" +
      "  Leave it unset while there is one relay; REEMOAT_CP_RELAY_URL is then the answer.",
  );
  process.exit(2);
}

// Must match relay/main.ts's slot name when the relay is external.
const relayId = (process.env["REEMOAT_CP_RELAY_ID"] ?? DEFAULT_RELAY_ID).trim() || DEFAULT_RELAY_ID;

const relayHost = process.env["REEMOAT_CP_RELAY_HOST"] ?? DEFAULT_RELAY_HOST;
const relayPort = Number.parseInt(process.env["REEMOAT_CP_RELAY_PORT"] ?? String(DEFAULT_RELAY_PORT), 10);
if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
  console.error(`REEMOAT_CP_RELAY_PORT must be a valid port, got "${process.env["REEMOAT_CP_RELAY_PORT"]}"`);
  process.exit(2);
}
if (relayEmbedded && relayPort === port) {
  console.error(
    `REEMOAT_CP_RELAY_PORT (${relayPort}) must differ from REEMOAT_CP_PORT (${port}).\n` +
      "  They are separate listeners so that publishing the relay does not publish /v1/admin/* with it.",
  );
  process.exit(2);
}
const issuer = (process.env["REEMOAT_CP_ISSUER"] ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER;
const dbPath = resolveDbPath(process.env["REEMOAT_CP_DB"]);

const tokenTtlSeconds = Number.parseInt(
  process.env["REEMOAT_CP_TOKEN_TTL_SECONDS"] ?? String(DEFAULT_TOKEN_TTL_SECONDS),
  10,
);
if (!Number.isInteger(tokenTtlSeconds) || tokenTtlSeconds < MIN_TOKEN_TTL_SECONDS) {
  console.error(
    `REEMOAT_CP_TOKEN_TTL_SECONDS must be an integer of at least ${MIN_TOKEN_TTL_SECONDS}, ` +
      `got "${process.env["REEMOAT_CP_TOKEN_TTL_SECONDS"]}".\n` +
      "  Below that the daemon's 60s clock leeway dominates the lifetime and the stated TTL stops\n" +
      "  meaning anything — a 60s token accepted with 60s of leeway either side lasts 180s.",
  );
  process.exit(2);
}

let store: ControlStore;
try {
  store = openControlStore({ path: dbPath });
} catch (error) {
  console.error(
    `could not open ${dbPath}: ${describeError(error)}\n` +
      "  Set REEMOAT_CP_DB to a writable path.",
  );
  process.exit(2);
}

const signing = ensureSigningKey(store.db);

const userCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM users").get()?.["n"] ?? 0);
if (userCount === 0) {
  const name = (process.env["REEMOAT_CP_BOOTSTRAP_ADMIN"] ?? "admin").trim() || "admin";

  const supplied = process.env["REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD"] ?? "";
  const generated = supplied.length === 0;
  const password = generated ? generatePassword() : supplied;
  const problem = checkPasswordPolicy(password, name);
  if (problem !== null) {
    console.error(`REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
    console.error("  Unset it to have one generated and printed here instead.");
    process.exit(2);
  }
  const passwordHash = await hashPassword(password, "authenticated");

  // deploy/install.sh scrapes the `API key:` line into cpctl.env, and imagecheck asserts it is printed once.
  const userId = newId("u");
  const key = newApiKey();
  const now = Date.now();
  store.db.exec("BEGIN");
  try {
    store.db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 1, ?)").run(userId, name, now);
    store.db
      .prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId("ak"), userId, key.prefix, key.hash, now);
    store.db
      .prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)")
      .run(userId, passwordHash, now);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }

  console.log("");
  console.log(`  bootstrapped admin user "${name}" (${userId})`);
  console.log(`  API key: ${key.key}`);
  // install.sh scrapes /^ *admin password: / and takes the last field: that prefix may appear only on a line carrying the password.
  if (generated) console.log(`  admin password: ${password}`);
  else console.log("  admin password source: REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD (not printed here)");
  console.log("  Shown once and only hashes are stored. Save them now.");
  console.log("");
} else {
  const withPasswords = Number(
    store.db.prepare("SELECT COUNT(*) AS n FROM user_passwords").get()?.["n"] ?? 0,
  );
  if (withPasswords === 0) {
    console.log("");
    console.log("  no user has a password yet, so nobody can sign in to the web UI.");
    console.log("  each person sets their own with:  cpctl passwd   (with their own REEMOAT_CP_KEY)");
    console.log("  an account with no password row needs no current password to set the first one.");
    console.log("  every existing API key keeps working either way.");
    console.log("");
  }
}

pruneSessions(store.db);

pruneRegistrations(store.db);
pruneEmailTokens(store.db);
pruneMailOutbox(store.db);
pruneEnrollmentCodes(store.db);
pruneDevices(store.db);

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const sweepTimer = setInterval(() => {
  try {
    pruneSessions(store.db);
    pruneRegistrations(store.db);
    pruneEmailTokens(store.db);
    pruneMailOutbox(store.db);
    pruneEnrollmentCodes(store.db);
    pruneDevices(store.db);
  } catch (error) {
    console.error(`sweep failed: ${describeError(error)}`);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

const tunnels = relayEmbedded
  ?
    new TunnelRegistry((event, detail) => console.error(`relay: ${event} ${detail}`), null, relayId)
  : null;
const relayView: RelayView = tunnels ?? dbRelayView(store.db);

// Only the gate is served, never the app; a missing build is survivable.
const gateRoot = fileURLToPath(new URL("../../web/dist-gate", import.meta.url));

// The Dockerfile COPY and .dockerignore must both carry deploy/bootstrap.sh. Missing is a 404, not a startup failure.
const installEnv = (process.env["REEMOAT_CP_INSTALL"] ?? "").trim();
// Affirmative spellings mean the default, not a path; deploycheck reads these spellings off this file.
const installOff = installEnv === "0" || installEnv === "false" || installEnv === "no";
const installDefault = installEnv === "1" || installEnv === "true" || installEnv === "yes";
const bootstrapScript =
  installOff
    ? null
    : installEnv.length > 0 && !installDefault
      ? (isAbsolute(installEnv) ? installEnv : join(process.cwd(), installEnv))
      : fileURLToPath(new URL("../../../deploy/bootstrap.sh", import.meta.url));

const mailPump = startMailPump({
  db: store.db,
  dialer: socketDialer(),
  onEvent: (event, detail) => {
    if (event === "sent") console.log(`mail: sent ${detail}`);
    else console.error(`mail: ${event} ${detail}`);
  },
});

/** Env only: the CSP's connect-src is built from it once at startup. */
const pluginCatalogueUrl = (process.env["REEMOAT_CP_PLUGIN_CATALOGUE_URL"] ?? "").trim() || null;
if (pluginCatalogueUrl !== null && !isBrowserReachable(pluginCatalogueUrl)) {
  console.warn(
    `REEMOAT_CP_PLUGIN_CATALOGUE_URL must be an absolute http:// or https:// URL, got "${pluginCatalogueUrl}".\n` +
      "  The browser fetches it directly, so it needs a scheme fetch() accepts. Ignoring it:\n" +
      "  this instance will offer no plugin market, and installing from a file still works.",
  );
}

// Warned about, never fatal (Q1.650). Read through process.env[key] so deploycheck can assert no literal read remains.
const RETIRED_ENV: Readonly<Record<string, string>> = {
  REEMOAT_CP_MACHINES_OFFER_URL: 'The "Rent a machine" link it drew is deleted.',
};
for (const [key, what] of Object.entries(RETIRED_ENV)) {
  if ((process.env[key] ?? "").trim().length === 0) continue;
  console.warn(
    `warning: ${key} is set and no longer does anything.\n` +
      `  ${what} Remove the line from this control plane's env file.`,
  );
}

/** Env only: it names one deployment's build, while SETTING_KEYS is drawn on every fork's settings screen. */
const appDownloadUrl = (process.env["REEMOAT_CP_APP_DOWNLOAD_URL"] ?? "").trim() || null;
if (appDownloadUrl !== null && !isBrowserReachable(appDownloadUrl)) {
  console.warn(
    `REEMOAT_CP_APP_DOWNLOAD_URL must be an absolute http:// or https:// URL, got "${appDownloadUrl}".\n` +
      "  It becomes a link on the page somebody lands on after signing up, so it needs a\n" +
      "  scheme a browser will follow. Ignoring it: the gate will say this server publishes\n" +
      "  no build and point at building from source, which is the default.",
  );
}

// Off unless set: an instance must claim the legal documents, never inherit them.
const legalRaw = (process.env["REEMOAT_CP_LEGAL_DOCUMENTS"] ?? "").trim().toLowerCase();
const legalDocuments = legalRaw !== "" && !["0", "off", "false", "no"].includes(legalRaw);

const app = createControlPlaneApp({
  db: store.db,
  issuer,
  tokenTtlSeconds,
  relayUrl,
  relay: relayView,
  bootstrapScript,
  mail: mailPump,
  trustedProxyHops,
  relayUrls,
  pluginCatalogueUrl: pluginCatalogueUrl !== null && isBrowserReachable(pluginCatalogueUrl) ? pluginCatalogueUrl : null,
  gateRoot,
  appDownloadUrl: appDownloadUrl !== null && isBrowserReachable(appDownloadUrl) ? appDownloadUrl : null,
  legalDocuments,
});

// Wraps app.fetch because middleware added after the routes would never run.
let warnedAboutForwarding = trustedProxyHops > 0;
const fetchWithProxyWarning: typeof app.fetch = (request, ...rest) => {
  if (!warnedAboutForwarding && forwardingIgnored(request.headers.get("x-forwarded-for") ?? undefined, trustedProxyHops)) {
    warnedAboutForwarding = true;
    console.warn(
      "a request arrived carrying x-forwarded-for and REEMOAT_CP_TRUSTED_PROXY_HOPS is 0,\n" +
        "  so it was ignored and the socket address was used instead. If a reverse proxy of\n" +
        "  yours really is in front of this service, set REEMOAT_CP_TRUSTED_PROXY_HOPS=1 —\n" +
        "  without it every caller shares one rate-limit bucket, and one person's failed\n" +
        "  sign-ins refuse everybody else's. If nothing is in front, that header was sent by\n" +
        "  hand and ignoring it is exactly the point.",
    );
  }
  return app.fetch(request, ...rest);
};

const server = serve({ fetch: fetchWithProxyWarning, hostname: host, port }, (info) => {
  console.log(`Reemoat control plane listening on http://${host}:${info.port}`);
  console.log(`issuer: ${issuer}`);
  console.log(`signing key: ${signing.kid}`);
  console.log(`token ttl: ${tokenTtlSeconds}s`);
  console.log(threadpoolNote());
  console.log(`state: ${dbPath}`);
  console.log(
    relayEmbedded
      ? `relay: ${relayUrl} (listening on ${relayHost}:${relayPort})`
      : `relay: ${relayUrl} (external — tunnels are held by another process; presence read from ${dbPath})`,
  );
  if (relayUrls !== null && relayEmbedded) {
    console.warn(
      "REEMOAT_CP_RELAY_URLS is set while REEMOAT_CP_RELAY_MODE is embedded, so it does\n" +
        "  nothing: this process holds the tunnels itself and can only ever route to\n" +
        "  itself. A fleet with more than one relay runs the API with\n" +
        "  REEMOAT_CP_RELAY_MODE=external. See deploy/RELAYS.md.",
    );
  }
  if (relayUrls !== null && !relayEmbedded) {
    const named = Object.entries(relayUrls)
      .map(([id, url]) => `${id} → ${url}`)
      .join(", ");
    console.log(`browsers are routed per machine: ${named}`);
    console.log(`  this relay answers as "${relayId}"; a machine on any other id falls back to ${relayUrl}`);
  }
  console.log(
    existsSync(gateRoot)
      ? `gate: ${gateRoot}`
      : `gate: NOT BUILT (${gateRoot}) — sign-up and password recovery links will not open.\n` +
        "  Build it with: pnpm --filter @reemoat/web build:gate",
  );
  console.log("web ui: none — this is the API and the relay; the Reemoat app is the client");

  const registration = readSetting(store.db, "registration.enabled");
  const mode = registrationMode(store.db);
  console.log(
    `registration: ${mode.enabled ? "open" : "closed"} (${registration.source})` +
      (mode.enabled ? `, email ${mode.requiresEmail ? "required" : "not required — no SMTP"}` : ""),
  );

  const mailState = mailConfigured(store.db);
  if (mailState.configured) {
    const smtp = readSetting(store.db, "smtp.host");
    console.log(`mail: ${smtp.value} (${smtp.source}), from ${readSetting(store.db, "mail.from").value}`);
    for (const problem of mailState.problems) console.log(`  note: ${problem}`);
  } else {
    console.log("mail: not configured — no registration confirmations and no password resets");
    for (const problem of mailState.problems) console.log(`  ${problem}`);
  }

  const publish = (process.env["REEMOAT_CP_PUBLISH"] ?? "").trim();
  if (mode.enabled && (publish === "0.0.0.0" || publish === "*" || publish === "::")) {
    console.log("");
    console.log("  warning: registration is open and this API is published on every interface.");
    console.log("           that is the port carrying /v1/admin/* — put a TLS proxy in front,");
    console.log("           or publish on one address. A published port is a DNAT rule that");
    console.log("           ufw and firewalld do not see.");
    console.log("");
  }
});

const relay =
  tunnels === null
    ? null
    : createRelayListener({
        db: store.db,
        issuer,
        host: relayHost,
        port: relayPort,
        registry: tunnels,
        onEvent: (event, detail) => console.error(`relay: ${event} ${detail}`),
        // listen fails asynchronously: without this, EADDRINUSE crashes after the one-time bootstrap key was printed.
        onListenError: (error) => {
          const detail = error.code === "EADDRINUSE" ? " — already in use" : "";
          console.error(`relay: cannot listen on ${relayHost}:${relayPort}${detail}`);
          console.error("set REEMOAT_CP_RELAY_PORT to a free port, or run the relay as its own service");
          process.exit(2);
        },
      });

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});

// Logs and continues: one stray socket error must not take every tunnel down.
process.on("uncaughtException", (error) => {
  console.error("uncaught exception (continuing):", error);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    console.error(`${signal} again — exiting immediately`);
    process.exit(130);
  }
  shuttingDown = true;
  console.error(`\n${signal}: stopping`);
  relay?.close();
  server.close();
  // Before store.close(); an interrupted send is safe because the outbox row is leased.
  mailPump.stop();
  // Runs work deferred until after a reply (POST /v1/forgot) before store.close(); defer bodies must be synchronous.
  const flushed = drainDeferred();
  if (flushed > 0) console.error(`flushed ${flushed} deferred task${flushed === 1 ? "" : "s"}`);
  store.close();
  console.error("stopped");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function resolveDbPath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return DEFAULT_DB;
  if (raw === ":memory:") return raw;
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    console.error(`REEMOAT_CP_DB must be an absolute path or ":memory:", got "${raw}"`);
    process.exit(2);
  }
  return expanded;
}
