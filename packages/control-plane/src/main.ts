#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createControlPlaneApp, drainDeferred, DEFAULT_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS } from "./app.js";
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

/**
 * The control plane's entry point.
 *
 * Shaped like `scripts/daemon.ts` — straight-line env parsing at the top,
 * `process.exit(2)` on bad config with a copy-pasteable fix, signals at the
 * bottom — because it is the same kind of program and an operator should not
 * have to learn two conventions.
 */

/**
 * The threadpool, and this is the belt while the braces are in the image.
 *
 * Mirrors `scripts/daemon.ts` exactly, including the caveat: libuv reads this
 * once, lazily, at the first piece of pool work, and in ESM every `import` above
 * is evaluated before this statement runs — so it takes effect only while nothing
 * in the import graph touches the pool during loading, which is a property of
 * today's imports rather than a guarantee, and it fails silently.
 *
 * `deploy/docker/Dockerfile`'s ENV and the `cp` script both set it before node
 * starts, which is the placement that cannot be outrun. {@link threadpoolNote}
 * prints what the process actually got, because a silent 4 is the failure.
 *
 * It matters here for one reason: `src/password.ts` runs scrypt on that pool, and
 * `serveStatic` — the web bundle — draws from the same one.
 */
process.env["UV_THREADPOOL_SIZE"] ??= "64";

/**
 * What this process was **configured** with, printed at startup because a silent
 * 4 is the failure.
 *
 * Not what libuv latched, and the distinction is the `??=` twelve lines up: this
 * reads `process.env` *after* that statement has already filled a missing value
 * with `"64"`, so on any path where nothing set the variable before `node`
 * started, this prints 64 while the pool may well be 4 — the exact silent failure
 * it exists to catch, in the one case it cannot see.
 *
 * It is truthful in deployment because all three launchers export it before node
 * starts, which is the placement that cannot be outrun:
 *
 *   - `deploy/docker/Dockerfile`'s `ENV UV_THREADPOOL_SIZE=64` (the image, which
 *     is how this service actually runs — `imagecheck` reads it back out of the
 *     running container),
 *   - `deploy/run-cp.sh`, which exports it before `exec`,
 *   - `packages/control-plane/package.json`'s `cp` script, for `pnpm cp`.
 *
 * What is left over is a bare `tsx src/main.ts`, where the `??=` is the belt and
 * this line is reporting the belt rather than the pool. Deliberately not
 * restructured: it mirrors `scripts/daemon.ts`, and two copies of this that read
 * differently would be worse than one caveat written down twice.
 *
 * The fallback arm survives because `??=` only fills an *absent* value: a variable
 * explicitly set to something libuv cannot parse reaches it, and 4 is then what
 * the pool really is.
 */
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
/**
 * The relay binds wide where the API binds loopback.
 *
 * Opposite defaults on purpose. The API holds the private key that mints every
 * token in the fleet, so exposing it should be a deliberate act. The relay is
 * useless unless daemons on other networks can dial it — that is the entire
 * feature — so binding it narrowly would only produce a confusing silence.
 *
 * They are separate ports rather than one, so publishing the relay does not
 * publish `/v1/admin/*` along with it.
 */
const DEFAULT_RELAY_HOST = "0.0.0.0";
/**
 * Localhost by default, unlike the daemon's 0.0.0.0.
 *
 * The daemon binds wide because reaching it over a Tailnet is the entire point.
 * This service holds the private key that mints every token in the fleet, so
 * exposing it is a decision somebody should have to make on purpose.
 */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DB = join(homedir(), ".reemoat", "control-plane.db");
const DEFAULT_ISSUER = "reemoat-cp";

const port = Number.parseInt(process.env["REEMOAT_CP_PORT"] ?? String(DEFAULT_PORT), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`REEMOAT_CP_PORT must be a valid port, got "${process.env["REEMOAT_CP_PORT"]}"`);
  process.exit(2);
}
const host = process.env["REEMOAT_CP_HOST"] ?? DEFAULT_HOST;

/*
 * **The relay is required, not a switch.**
 *
 * It used to be optional, and unset meant "every machine reports relayOnline:
 * false and clients see the pre-relay behaviour" — which was a coherent state
 * while clients reached daemons directly. They do not: the relay is the only
 * entrance, so a control plane without one is a fleet nobody can reach, and
 * starting anyway would produce a UI that lists machines and cannot open any of
 * them.
 *
 * The URL itself is still the piece of configuration that cannot be guessed:
 * this process has no way to know what hostname daemons and browsers reach it
 * by, and that URL is handed out at enrollment and with every token. Deriving it
 * from the bind address would produce `http://0.0.0.0:7889`, which works nowhere.
 */
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

/*
 * **Who is holding the tunnels — this process, or another one.**
 *
 * `embedded` is what this file has always done and stays the default: one
 * process, one in-memory `TunnelRegistry`, which is what `pnpm cp` runs and what
 * every offline driver builds.
 *
 * `external` says a *separate* relay process owns the listener, and it exists
 * because the two have opposite restart costs. Recreating this service is
 * ordinary — a web bundle moved, a route changed — and it took every tunnel in
 * the fleet with it, costing every open session tens of seconds of reconnecting
 * and every in-flight request outright. The relay's own inputs move rarely, so
 * splitting them is what makes a backend deploy free.
 *
 * This is **not** `REEMOAT_RELAY=0`, which was deleted for saying something else
 * entirely: there is still exactly one relay and it is still the only way in.
 * `REEMOAT_CP_RELAY_URL` stays required in both modes for that reason — what
 * changes is which process listens, never whether anything does.
 */
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

/*
 * How much of `x-forwarded-for` this instance believes.
 *
 * Zero — ignore it — is the default, because a header nobody vouched for is a
 * rate-limit key the caller writes. See `net.ts`; the short version is that
 * reading it unconditionally let anybody defeat the login throttle by rotating
 * the header, and *aim* it at somebody by spelling their address into it.
 *
 * Refused rather than defaulted on a bad value, like every other listener
 * setting here: a typo that silently means "trust nothing" is a throttle whose
 * buckets all collapse onto one proxy, and the symptom shows up as other
 * people's failed sign-ins refusing yours.
 */
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

/*
 * Where a **browser** reaches each relay, by slot name.
 *
 * `REEMOAT_CP_RELAY_URLS=relay-1=https://r1.example,relay-2=https://r2.example`,
 * and unset is the shape every deployment has until somebody runs a second
 * relay: one relay, `REEMOAT_CP_RELAY_URL` is where everybody goes.
 *
 * ⚠ **`https`, not `wss`, and this example said `wss` until it was measured.**
 * The refusal eight lines below rejects a WebSocket scheme outright — the client
 * derives `wss` from `https` itself — so an operator following
 * `deploy/RELAYS.md`'s instruction to read this source got a control plane that
 * `exit(2)`s on the value it had just been shown. An example inside a docblock is
 * copied exactly as often as one in a README, and nothing checks it.
 *
 * **Two different questions, which is why this is not just a plural
 * `RELAY_URL`.** `REEMOAT_CP_RELAY_URL` is the name *daemons* dial; it is
 * written into each daemon's `identity.relay_url` at enrollment and never asked
 * about again, so it has to stay one value and point at whatever fronts the
 * relays. This is the name a *browser* dials, and it has to be the specific
 * relay holding that machine's tunnel, because a `TunnelRegistry` is in-memory
 * per process. See `relayUrlFor` in `app.ts`.
 *
 * Refused rather than ignored on a malformed entry, like every listener setting
 * here: a typo means browsers quietly fall back to the shared name and get a
 * one-in-N coin flip per request, which reads as "the fleet is flaky" and not as
 * "one line of config is wrong".
 */
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

/*
 * This process's own slot name, and it has to match what `relay/main.ts` uses
 * when the relay is external — they write and read the same
 * `relay_tunnels.relay_id`. Embedded, nothing compares it against anything; it
 * is passed to the registry anyway so the two shapes cannot drift.
 */
const relayId = (process.env["REEMOAT_CP_RELAY_ID"] ?? DEFAULT_RELAY_ID).trim() || DEFAULT_RELAY_ID;

const relayHost = process.env["REEMOAT_CP_RELAY_HOST"] ?? DEFAULT_RELAY_HOST;
const relayPort = Number.parseInt(process.env["REEMOAT_CP_RELAY_PORT"] ?? String(DEFAULT_RELAY_PORT), 10);
if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
  console.error(`REEMOAT_CP_RELAY_PORT must be a valid port, got "${process.env["REEMOAT_CP_RELAY_PORT"]}"`);
  process.exit(2);
}
/*
 * Only when this process is going to bind it.
 *
 * Under `external` the two numbers name listeners in two different containers,
 * and they routinely *are* the same value on the host side of two published
 * ports — refusing that would refuse an ordinary deployment over a collision
 * that cannot happen.
 */
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

/*
 * Bootstrap.
 *
 * The chicken-and-egg: every administrative route needs an admin API key, and
 * the only way to make one is an administrative route. So the first start with
 * no users mints an admin and prints its key exactly once. This is the only
 * time any credential is ever printed.
 */
const userCount = Number(store.db.prepare("SELECT COUNT(*) AS n FROM users").get()?.["n"] ?? 0);
if (userCount === 0) {
  const name = (process.env["REEMOAT_CP_BOOTSTRAP_ADMIN"] ?? "admin").trim() || "admin";

  /*
   * The password: the operator's, or one nobody has seen before.
   *
   * Refused rather than quietly weakened when a supplied one fails the policy. A
   * control plane that accepted `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` and then
   * stored something else would be one whose admin password is not the password
   * the operator believes it is, which is worse than refusing to start with a
   * sentence saying what to change.
   */
  const supplied = process.env["REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD"] ?? "";
  const generated = supplied.length === 0;
  const password = generated ? generatePassword() : supplied;
  const problem = checkPasswordPolicy(password, name);
  if (problem !== null) {
    console.error(`REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
    console.error("  Unset it to have one generated and printed here instead.");
    process.exit(2);
  }
  // Top-level await, on the one code path where nothing is listening yet and no
  // tunnel is attached — so the ~50ms this costs blocks nobody. Everywhere else
  // hashing goes to the threadpool for exactly the opposite reason.
  //
  // `"authenticated"`, which is the honest answer rather than a convenience: the
  // public lane exists to be starved by strangers, and this runs before anything
  // can reach the process at all.
  const passwordHash = await hashPassword(password, "authenticated");

  /*
   * An API key **as well**, and it is not a hedge.
   *
   * `deploy/install.sh` scrapes this exact line out of the container's log and
   * writes `~/.reemoat/cpctl.env` with it; `deploy/lib.sh`'s `cpctl()` reads that
   * file; `scripts/imagecheck.ts` asserts it is printed exactly once. Beyond the
   * scripts, the admin is the one account that needs a credential which works with
   * no browser and no web build — that is the whole reason `cpctl` exists — and it
   * is the only credential that survives rolling this service back past the
   * release that added passwords.
   *
   * `POST /v1/admin/users` is the route that stopped minting one by default. This
   * is the deploy's own bootstrap, which is a different thing.
   */
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
  /*
   * Its own line, and the marker is load-bearing in two directions — one of which
   * held and one of which did not.
   *
   * Held: `install.sh` scrapes `/API key: /` and takes the last field, and this
   * line must not match that or the installer writes a password into `cpctl.env`
   * as if it were a key. `admin password: ` shares no substring with `API key: `,
   * and `imagecheck` counts both, so neither marker can pick up its neighbour's
   * value.
   *
   * Did not: **a marker collided with itself.** `install.sh` also scrapes
   * `/^ *admin password: /` and takes the last field, and the second arm here
   * used to read `admin password: taken from …_PASSWORD (not printed)` — a line
   * carrying no password whose `$NF` is the literal `printed)`. The installer
   * duly printed `admin password: printed)` and told the operator to sign in
   * with it. That arm is option 2 of the wizard's own prompt and `imagecheck`
   * only ever drives the generated one, so nothing anywhere saw it.
   *
   * So the rule is stronger than "do not look like the other marker": the string
   * `admin password: ` must never appear on a line that does not carry the
   * password. `admin password source: ` is a different prefix, not a different
   * suffix — a scrape anchored on the old one cannot match it however it is
   * worded afterwards.
   */
  if (generated) console.log(`  admin password: ${password}`);
  else console.log("  admin password source: REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD (not printed here)");
  console.log("  Shown once and only hashes are stored. Save them now.");
  console.log("");
} else {
  /*
   * The nag, and it is the only signal an existing deployment gets.
   *
   * A deploy of this feature onto a database that already has users bootstraps
   * nothing — correctly, since `users` is not empty — so nobody has a password and
   * the sign-in screen would refuse everybody with no explanation. One line, at
   * most once per start, and only while the condition actually holds.
   */
  const withPasswords = Number(
    store.db.prepare("SELECT COUNT(*) AS n FROM user_passwords").get()?.["n"] ?? 0,
  );
  if (withPasswords === 0) {
    console.log("");
    console.log("  no user has a password yet, so nobody can sign in to the web UI.");
    /*
     * **This is the only signal an existing deployment gets**, and it named
     * `cpctl admin passwd <userId>` — a command that no longer exists, because an
     * admin can no longer set anybody's password but their own. Naming a deleted
     * remedy on the one line somebody reads when nobody can sign in is worse than
     * naming none, so it names the one that works: each person, with their own
     * key, setting their own first password.
     */
    console.log("  each person sets their own with:  cpctl passwd   (with their own REEMOAT_CP_KEY)");
    console.log("  an account with no password row needs no current password to set the first one.");
    console.log("  every existing API key keeps working either way.");
    console.log("");
  }
}

/*
 * Sessions that can never authenticate again, dropped once, here.
 *
 * `pruneSessions` is the one of these five that genuinely only needs a boot:
 * the table is bounded by the per-user cap already, so this is housekeeping.
 * It runs on the sweep below anyway, because splitting one call out of four
 * would be a second schedule to reason about for no gain.
 */
pruneSessions(store.db);

/*
 * The four tables that hold expiring things, swept beside it.
 *
 * `pruneRegistrations` is the one that is not merely housekeeping: a sign-up
 * holds its login name until it expires, and this is what actually releases the
 * name. The other two are bounded by their own expiry and swept so an instance
 * that has been up for a year is not carrying a year of dead links.
 */
pruneRegistrations(store.db);
pruneEmailTokens(store.db);
pruneMailOutbox(store.db);
pruneEnrollmentCodes(store.db);

/**
 * How often the five sweeps above run again.
 *
 * ⚠ **They used to run exactly once, at startup, and that stopped being enough
 * the day the relay moved out of this process.** The whole argument for the split
 * is that this container is the one that gets recreated and the relay is the one
 * that stays up — but the API is `restart: unless-stopped` behind a deploy
 * script that only recreates it when the image moved, so "a control plane that
 * has been up for months" is the ordinary state rather than the exotic one, and
 * in that state nothing here ever swept.
 *
 * What that costs is not symmetric across the five. `pruneRegistrations` holds a
 * login name until it expires, so a sign-up that was abandoned keeps its name
 * reserved for as long as the process lives rather than for 24h. And
 * `pruneMailOutbox` is the one that holds a **credential**: a message's `body`
 * carries its own one-time link, cleared on success and kept on failure only
 * until the token's own expiry — which is a sentence about a sweep that was not
 * running.
 *
 * Six hours, `unref`'d. Long enough that this is not a schedule anybody has to
 * think about, short enough that "until the next restart" is never the answer to
 * how long a dead link is kept. Unref'd because a sweep must never be the reason
 * a process stays alive, which is the same rule `startPresenceFlush` follows one
 * package over.
 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const sweepTimer = setInterval(() => {
  /*
   * Guarded as one, deliberately. These are best-effort housekeeping on a
   * database two processes share with a 250ms busy timeout, so a `SQLITE_BUSY`
   * must cost one skipped sweep rather than an unhandled rejection on the
   * process holding the API — and the next tick repairs whatever was missed,
   * exactly as the relay's own flush does.
   */
  try {
    pruneSessions(store.db);
    pruneRegistrations(store.db);
    pruneEmailTokens(store.db);
    pruneMailOutbox(store.db);
    pruneEnrollmentCodes(store.db);
  } catch (error) {
    console.error(`sweep failed: ${describeError(error)}`);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

/*
 * The relay, which is not optional.
 *
 * This block used to be written for two states, gated on a `relayEnabled` that
 * had already become `true` unconditionally — four dead branches and a comment
 * describing "when the relay is off", which is a state `main.ts` now refuses to
 * start in (see the exit above). Every request to every machine goes down a
 * tunnel, so a control plane without one is a fleet nobody can reach.
 *
 * A registry with no tunnels still answers `isOnline: false` for every machine,
 * which remains the correct answer while daemons are dialling in. Nothing in the
 * token-issuing path depends on any of it.
 *
 * Under `external` there is no registry here at all — the tunnels are in another
 * process — and `relayOnline` is answered from `relay_tunnels` instead. Both are
 * the same `RelayView`, which is why `app.ts` does not know the difference and
 * did not change for any of this.
 */
const tunnels = relayEmbedded
  ? // `relayId` so `relayFor` names this process the same way the writer would.
    // Embedded, nothing reads it — there is one relay and it is here — but a
    // registry that answered with a *different* name than it stamps into the
    // table would be a trap the day somebody splits.
    new TunnelRegistry((event, detail) => console.error(`relay: ${event} ${detail}`), null, relayId)
  : null;
const relayView: RelayView = tunnels ?? dbRelayView(store.db);

/*
 * The built web client, if there is one.
 *
 * Resolved from this file rather than the working directory, because `pnpm cp`
 * runs from the package root while a bare `tsx src/main.ts` does not, and a UI
 * that appears or vanishes depending on where you started the process is a
 * miserable thing to debug. `REEMOAT_CP_WEB=0` opts out; a path overrides.
 */
const webEnv = (process.env["REEMOAT_CP_WEB"] ?? "").trim();
const webRoot =
  webEnv === "0"
    ? null
    : webEnv.length > 0
      ? (isAbsolute(webEnv) ? webEnv : join(process.cwd(), webEnv))
      : fileURLToPath(new URL("../../web/dist", import.meta.url));

/*
 * Outgoing mail — the first outbound connection this service has ever made.
 *
 * `socketDialer()` is the only thing in this process that opens one, and the
 * pump behind it sends **one message at a time** with hard per-step budgets. The
 * reason is not politeness to the mail server: `net.connect` resolves names with
 * `dns.lookup`, which is `getaddrinfo` on the libuv threadpool — the same pool
 * `scrypt` runs on and `serveStatic` draws from. A mail host that accepts the
 * connection and never answers would otherwise consume pool slots until password
 * hashing queued behind it and the sign-in page stopped loading. A mail outage
 * must never become a sign-in outage.
 */
const mailPump = startMailPump({
  db: store.db,
  dialer: socketDialer(),
  onEvent: (event, detail) => {
    // Nothing in `src/` prints; this is the entry point, which does. Failures to
    // stderr because they are the ones an operator greps for.
    if (event === "sent") console.log(`mail: sent ${detail}`);
    else console.error(`mail: ${event} ${detail}`);
  },
});

const app = createControlPlaneApp({
  db: store.db,
  issuer,
  tokenTtlSeconds,
  relayUrl,
  relay: relayView,
  webRoot,
  mail: mailPump,
  trustedProxyHops,
  relayUrls,
});

/*
 * Said **once**, the first time a request arrives carrying a forwarding header
 * this instance is ignoring.
 *
 * The misconfiguration this catches is silent in both directions and neither is
 * visible from inside: a real proxy in front with hops at zero puts every caller
 * in one throttle bucket, so one person's failed sign-ins refuse everybody
 * else's — a symptom nobody traces back to an unset variable. Warning at startup
 * instead would warn on every instance that has no proxy, which is the default
 * and the majority.
 *
 * **Wrapped around `app.fetch` rather than registered as middleware**, and that
 * is not a style choice: Hono runs handlers in registration order, so an
 * `app.use("*")` added out here — after `createControlPlaneApp` has registered
 * every route — sits below all of them and would never run. Wrapping is also the
 * honest home for it, because `app.ts` may not print (nothing there writes to a
 * stream, by the same rule `src/` follows) and because which proxy stands in
 * front is a fact about the *deployment*, which is this file's subject.
 */
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
  /*
   * The routing map, printed only when there is one — and printed at all for the
   * reason `threadpoolNote` exists: a value that silently did not take is the
   * failure mode this block is written against. An operator adding a second
   * relay needs to see that the API read their map, because the symptom of a
   * typo is not an error, it is one request in N answering `503 no_tunnel`
   * forever while everything looks fine.
   *
   * The relay ids are named rather than counted, so a missing entry is visible
   * beside `cpctl admin relay`'s list of who is actually connected.
   */
  if (relayUrls !== null && relayEmbedded) {
    /*
     * A map with no second relay to name. Worth a line rather than silence: the
     * embedded registry answers `relayFor` with "me or nobody" by construction,
     * so every machine resolves to this process and the map is inert — which is
     * exactly the shape an operator lands in by adding relays without moving the
     * API to `external`, and exactly the failure `deploy/RELAYS.md` says will
     * not announce itself.
     */
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
    webRoot === null
      ? "web ui: disabled"
      : existsSync(webRoot)
        ? `web ui: ${webRoot}`
        : `web ui: not built (${webRoot}) — run: pnpm --filter @reemoat/web build`,
  );

  /*
   * Both settings, **and where each one came from**.
   *
   * A row in `instance_settings` beats the environment, so without the source an
   * operator reads `REEMOAT_CP_REGISTRATION_ENABLED=true` in their env file,
   * reads "registration: closed" here, and has no way to tell which is live
   * short of opening SQLite. `deploy/compose.sh config` shows only one of the
   * two sides, which is precisely the confusion this line prevents.
   */
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

  /*
   * The one combination worth a warning.
   *
   * `compose.yml` already shouts that on Linux a published port is a DNAT rule
   * evaluated *before* the chain ufw and firewalld write to, so `ufw deny` will
   * not take it back. Opening registration on a wildcard-published API port
   * means strangers can create accounts on the listener that also carries
   * `/v1/admin/*` and, behind it, the key that mints every token in the fleet.
   * Not refused — it is a legitimate thing to want behind a TLS proxy — but not
   * something to discover later either.
   */
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

/*
 * The listener, when this process is the one holding it.
 *
 * Under `external` there is nothing to start here: another process binds the
 * relay port, and this one only *reads* which machines it is carrying. That is
 * the whole of the split on this side.
 */
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
        /*
         * A listener error, reported as a message rather than a stack.
         *
         * `listen` fails *asynchronously*, so without this the API has already
         * printed "listening" and — on a first run — already printed the
         * bootstrap admin API key before the relay's `EADDRINUSE` arrives as an
         * unhandled error. The operator therefore sees a successful start
         * followed by a crash, and on the rerun the printed key is gone for
         * good, because `users` is no longer empty.
         *
         * Every other bad configuration in this file exits(2) with a sentence
         * saying what to change; this one had a raw stack. Same treatment.
         */
        onListenError: (error) => {
          const detail = error.code === "EADDRINUSE" ? " — already in use" : "";
          console.error(`relay: cannot listen on ${relayHost}:${relayPort}${detail}`);
          // Not "unset REEMOAT_CP_RELAY_URL to run without a relay", which is
          // what this said: that value is refused at startup, so the one remedy
          // printed here turned a bound port into a service that will not come up
          // at all. There is no running without a relay any more.
          console.error("set REEMOAT_CP_RELAY_PORT to a free port, or run the relay as its own service");
          process.exit(2);
        },
      });

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});

/**
 * A backstop, not a licence.
 *
 * This process holds the API, the relay, the web UI and every daemon's tunnel.
 * Exiting on one stray socket error means a single client's bad network takes the
 * whole fleet offline and every daemon reconnects into nothing until a supervisor
 * intervenes — an availability failure far worse than whatever raised the error.
 *
 * The specific case that motivated this was a raw upgrade socket with no `error`
 * listener during the tunnel round trip (see `handleUpgrade` in `relay/proxy.ts`,
 * which now attaches one first thing). That is fixed at the source; this stays
 * because the same shape is easy to reintroduce anywhere a socket is handled
 * outside a framework, and the failure mode is the entire service.
 *
 * Deliberately not swallowed silently: it is logged loudly, because a handler that
 * hides bugs is how a process ends up running in a state nobody can reason about.
 */
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
  // Tunnels first, so daemons see a close and start reconnecting rather than
  // holding a socket into a process that is on its way out. Nothing to do under
  // `external`: the tunnels are in a process this signal is not about, and that
  // is the point of the mode.
  relay?.close();
  server.close();
  /*
   * Before `store.close()`, because the pump writes to that database.
   *
   * It does not wait for a send in flight, and it does not need to: the row is
   * leased rather than deleted, so a message interrupted here becomes eligible
   * again at the next boot instead of being lost or sent twice.
   */
  mailPump.stop();
  /*
   * Work a route answered before doing, run now rather than dropped.
   *
   * `POST /v1/forgot` replies and *then* mints the reset token and queues the
   * mail, so that the response time cannot say whether an address owns an account.
   * Between those two points a SIGTERM would have thrown the reset away with
   * nothing recorded anywhere and the caller already told it was sent — on the one
   * flow that is somebody's only way back into their account.
   *
   * Before `store.close()` for `mailPump.stop()`'s reason: this writes to that
   * database. Synchronous, which `defer` requires of every body precisely so this
   * line can sit on a shutdown path that has to stay one.
   */
  const flushed = drainDeferred();
  if (flushed > 0) console.error(`flushed ${flushed} deferred task${flushed === 1 ? "" : "s"}`);
  store.close();
  console.error("stopped");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Where durable state lives. Deliberately not relative to the cwd, for the same
 * reason as the daemon's: state that depends on which terminal you launched
 * from is a surprise waiting to happen.
 */
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
