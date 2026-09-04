#!/usr/bin/env node
import { createServer, get as httpGet, type Server } from "node:http";
import { connect as h2connect, createServer as createH2Server, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { Duplex, PassThrough } from "node:stream";
import { connect as netConnect, createServer as netCreateServer, type AddressInfo, type Socket } from "node:net";
import { TLSSocket, createServer as tlsCreateServer } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { publicKeyToJwk, signToken, type TokenClaims } from "../src/token.js";
import { CORS_ALLOW_METHODS } from "../src/cors.js";
import { describeError } from "../src/http.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { KEY_REFRESH_MS, createRelayAuthorizer } from "../packages/control-plane/src/relay/authorize.js";
import {
  CLOSE_TUNNEL_SUPERSEDED,
  CONNECTION_WINDOW_BYTES,
  MAX_STREAMS_PER_SUBJECT,
  MAX_TUNNEL_BUFFERED_BYTES,
  MAX_TUNNEL_MESSAGE_BYTES,
  RECONNECT_MAX_MS,
  AGENT_CLIS_HEADER,
  DAEMON_VERSION_HEADER,
  MAX_AGENT_CLIS_CHARS,
  MAX_DAEMON_VERSION_CHARS,
  formatAgentClis,
  parseAgentClis,
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  TUNNEL_AGREED_VERSION_HEADER,
  negotiateProtocolVersion,
  STREAM_ENCRYPTION_HEADER,
  STREAM_ENCRYPTION_NONE,
  STREAM_SUBJECT_HEADER,
  STREAM_VERSION_HEADER,
  STREAM_WINDOW_BYTES,
  TUNNEL_PATH,
  TUNNEL_VERSION_HEADER,
  reconnectDelayMs,
} from "../src/relay/protocol.js";
import { RELAY_HEALTH_PATH, createRelayListener } from "../packages/control-plane/src/relay/listener.js";
import {
  DEFAULT_RELAY_ID,
  PRESENCE_STALE_MS,
  RELAY_CLAIM_STALE_MS,
  claimRelayId,
  createPresenceWriter,
  dbRelayView,
  releaseRelayId,
} from "../packages/control-plane/src/relay/presence.js";
import { RelayTunnel as EndpointTunnel, TunnelRegistry } from "../packages/control-plane/src/relay/registry.js";
import {
  ensureSigningKey,
  issueTunnelKey,
  keyIdFor,
  mintSigningKey,
  newApiKey,
  newId,
  pruneEnrollmentCodes,
  retireSigningKey,
} from "../packages/control-plane/src/keys.js";
import { createControlPlaneApp } from "../packages/control-plane/src/app.js";
import { applyControlPlaneSchema } from "../packages/control-plane/src/store.js";
import { readAgentClisHeader, readDaemonVersionHeader, recordDaemonBuild } from "../packages/control-plane/src/machines.js";
import { callerAddressOf, forwardingIgnored } from "../packages/control-plane/src/net.js";
import { isBrowserReachable, parseRelayUrls } from "../packages/control-plane/src/relay/routing.js";
import {
  LAST_SEEN_WRITE_INTERVAL_MS,
  MAX_SESSIONS_PER_USER,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  listSessions,
  mintSession,
  pruneSessions,
  resolveSession,
  touchSession,
} from "../packages/control-plane/src/sessions.js";
import {
  ADDRESS_THROTTLE,
  DEFAULT_THROTTLE,
  LoginThrottle,
  addressKey,
  confirmKey,
  enrollKey,
  loginKey,
  mailKey,
  mailTestKey,
  passwordChangeKey,
  provisionKey,
  WRITE_THROTTLE,
  writeKey,
  registerKey,
  resetKey,
  resetMailKey,
} from "../packages/control-plane/src/throttle.js";
import {
  SMTP_TIMEOUTS,
  SmtpError,
  sanitizeReply,
  sendMessage,
  socketDialer,
  type SmtpConnection,
  type SmtpDialer,
} from "../packages/control-plane/src/mail/smtp.js";
import {
  MAX_OUTBOX_PENDING,
  backoffMs,
  claimNextMail,
  enqueueMail,
  expireStaleMail,
  mailHealth,
  pruneMailOutbox,
  recordMailFailure,
  recordMailSent,
  startMailPump,
  type EnqueueArgs,
  type MailEvent,
} from "../packages/control-plane/src/mail/outbox.js";
import { buildMessage, dotStuff, encodeWord, headerSafe } from "../packages/control-plane/src/mail/message.js";
import { checkEmailAddress, foldEmail } from "../packages/control-plane/src/mail/address.js";
import {
  VERIFY_TTL_MS,
  mintEmailToken,
  pruneEmailTokens,
  readEmailToken,
} from "../packages/control-plane/src/emails.js";
import {
  REGISTRATION_TTL_MS,
  mintRegistration,
  nameTaken,
  pruneRegistrations,
} from "../packages/control-plane/src/registration.js";
import {
  SETTING_KEYS,
  checkSettingValue,
  clearSetting,
  envNameFor,
  readSetting,
  writeSetting,
} from "../packages/control-plane/src/settings.js";
import {
  CURRENT_PARAMS,
  PASSWORD_MAX_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  normalizePassword,
  verifyPassword,
} from "../packages/control-plane/src/password.js";
import {
  MACHINE_LABEL_HELP,
  MACHINE_LABEL_RESERVED,
  MACHINE_LABEL_RESERVED_HELP,
  MAX_MACHINES_PER_USER,
  labelIsWellFormed,
  relabelMachine,
} from "../packages/control-plane/src/machines.js";
import {
  clearMachineLimit,
  effectiveLimit,
  instanceMachineLimit,
  machineStanding,
  overLimitMachineIds,
  writeMachineLimit,
} from "../packages/control-plane/src/quota.js";

import { tmp } from "./tmp.js";

/**
 * The regression driver for the relay.
 *
 * Same role as `authcheck.ts` for the auth paths and `harness.ts` for the session
 * paths: there is no test framework here, so "testable" means "drivable from
 * `scripts/`". Everything below runs in one process against loopback — no
 * control-plane deploy, no daemon, no agent — so it can be run after any change
 * to the relay without setting up a fleet.
 *
 * The case that earns this file's existence is `flow control`. Multiplexing is
 * easy to get visibly right and quietly wrong: an implementation with no
 * backpressure behaves perfectly until a real client on a real bad network stops
 * reading, at which point memory grows without bound on a machine nobody is
 * watching. The obvious library for this job — `yamux-js` — has exactly that bug
 * (it replenishes a stream's receive window when bytes *arrive* rather than when
 * they are *read*), which is why the tunnel is HTTP/2 instead. The test below is
 * what stops us regressing back into that shape.
 *
 *   pnpm relaycheck
 */

/*
 * ⚠ **Every setting name is cleared out of the environment before a single
 * fixture runs, and this is a *hermeticity* guard rather than tidiness.**
 * `readSetting` resolves database → environment → unset, so a block that opens a
 * fresh `:memory:` database and writes no row falls straight through to whatever
 * the operator running this driver happens to have exported. Measured: with
 * `REEMOAT_CP_REGISTRATION_ENABLED=true` in the shell three assertions go red
 * ("registration is closed unless somebody opened it" and the two under it);
 * with `REEMOAT_CP_MACHINES_PER_USER=10`, "the last slot is usable" goes red;
 * with the `REEMOAT_CP_SMTP_*` names set, "without mail the account exists at
 * once" goes red. All of them on unmodified source, and all of them only for the
 * one person most likely to run this — whoever also runs `pnpm cp` locally, since
 * the control plane has no dotenv loader and exporting these names is the only
 * way to configure it.
 *
 * `ubuntu-latest` carries none of them, so CI never saw any of it. That is the
 * mirror of the defect `daemoncheck`'s contributed-harness fixture had, where the
 * host decided the verdict in the other direction — and the rule that closes both
 * is the same: a driver asserts what its fixture decided, never what the machine
 * happens to be configured for.
 *
 * Swept over `SETTING_KEYS` through `envNameFor` rather than a hand-written list,
 * so a setting added later is covered on the day it is added. The two blocks that
 * genuinely want a value in the environment — `envNameFor`'s own round trip and
 * the `source: "environment"` pair — set it themselves and restore afterwards,
 * which is unaffected: they save `undefined` now and delete on the way out.
 */
for (const key of SETTING_KEYS) delete process.env[envNameFor(key)];

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

/* ------------------------------------------------------------------ *
 * A control plane, in memory
 * ------------------------------------------------------------------ */

const ISSUER = "relaycheck";
const db = new DatabaseSync(":memory:");
applyControlPlaneSchema(db);

const signing = ensureSigningKey(db);
const now = Date.now();

function addUser(id: string, disabled = false): string {
  db.prepare("INSERT INTO users (id, name, is_admin, created_at, disabled_at) VALUES (?, ?, 0, ?, ?)").run(
    id,
    id,
    now,
    disabled ? now : null,
  );
  return id;
}
function addMachine(id: string): string {
  db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(id, id, now, now);
  return id;
}
function grant(userId: string, machineId: string): void {
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    machineId,
    "session:read session:write",
    now,
  );
}

const alice = addUser("u_alice");
const mallory = addUser("u_mallory");
const disabled = addUser("u_disabled", true);
const mine = addMachine("m_mine");
const other = addMachine("m_other");
grant(alice, mine);
grant(disabled, mine);
// mallory deliberately has no grant anywhere.

const myTunnelKey = issueTunnelKey(db, mine);
const otherTunnelKey = issueTunnelKey(db, other);

function tokenFor(subject: string, audience: string, ttlSeconds = 300): string {
  const seconds = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: ISSUER,
    sub: subject,
    aud: audience,
    jti: newId("t"),
    iat: seconds,
    nbf: seconds,
    exp: seconds + ttlSeconds,
    scp: ["session:read", "session:write"],
  };
  return signToken(claims, signing.kid, signing.privateKey);
}

/* ------------------------------------------------------------------ *
 * A daemon, in memory
 *
 * Not the real one — this file must not need an agent — but the same shape: an
 * ordinary HTTP server with a WebSocket on it. `/flood` is what makes the
 * flow-control case possible without manufacturing a megabyte of transcript, and
 * `/stream` stands in for `/sessions/:id/stream`.
 * ------------------------------------------------------------------ */

let floodWritten = 0;
const daemon = createServer((req, res) => {
  const target = req.url ?? "/";
  /*
   * A daemon that answers, sends part of what it promised, and then goes silent
   * for ever.
   *
   * Deliberately not a closed port and not a reset: it is the shape of a body
   * that stops arriving mid-flight, which is the one thing the relay's own idle
   * bound has to be able to end. `content-length` is the point of it — a client
   * holding this response is waiting on bytes nobody is going to send.
   */
  if (target.startsWith("/halfbody")) {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(1024 * 1024) });
    res.write(Buffer.alloc(64 * 1024, 97));
    return;
  }
  if (target.startsWith("/flood")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(16 * 1024, 7);
    /*
     * Endless by default, bounded by `?bytes=`.
     *
     * One route because the two cases differ only in when the writer stops, and
     * they are the two halves of the same requirement: the endless form is the
     * client that never reads (does the sender stop?), the bounded form is the
     * client that does (does the sender ever start again?). The bounded form
     * keeps its own counter — `floodWritten` is what the stalled case asserts on,
     * and a second writer moving it would make that assertion mean nothing.
     */
    const query = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
    const want = Number(new URLSearchParams(query).get("bytes") ?? "0");
    if (want > 0) {
      let sent = 0;
      const pumpBounded = (): void => {
        while (sent < want) {
          const piece = chunk.subarray(0, Math.min(chunk.length, want - sent));
          const wrote = res.write(piece);
          sent += piece.length;
          if (!wrote) {
            res.once("drain", pumpBounded);
            return;
          }
        }
        res.end();
      };
      pumpBounded();
      return;
    }
    const pump = (): void => {
      // Writes until the socket says stop. With working flow control that is a
      // bounded amount; without it, this never stops.
      while (res.write(chunk)) {
        floodWritten += chunk.length;
        if (floodWritten > 256 * 1024 * 1024) return;
      }
      floodWritten += chunk.length;
      res.once("drain", pump);
    };
    pump();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, subject: req.headers["reemoat-sub"] ?? null }));
});

/*
 * The daemon's WebSocket, shaped like the real one.
 *
 * Sends a `hello` frame unprompted on open, exactly as `StreamConnection` does,
 * then echoes. Both halves matter: the unprompted frame proves the daemon can
 * write down a tunnelled upgrade before the client says anything, and the echo
 * proves the reverse direction. The relay carries opaque bytes, so if either
 * direction were mis-spliced this is where it would show.
 */
const daemonWss = new WebSocketServer({ noServer: true });
daemon.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://daemon").pathname;
  if (path !== "/stream") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  daemonWss.handleUpgrade(req, socket, head, (ws) => {
    // The daemon sees the caller's real token on the relayed request, exactly as
    // it does on the direct path. Echoed back so the case can assert it arrived.
    const url = new URL(req.url ?? "/", "http://daemon");
    ws.send(JSON.stringify({ type: "hello", token: url.searchParams.get("token") === null ? null : "present" }));
    ws.on("message", (data: Buffer) => ws.send(JSON.stringify({ type: "echo", text: data.toString() })));
  });
});

/* ------------------------------------------------------------------ *
 * A relay
 * ------------------------------------------------------------------ */

/*
 * **The shipped listener, not a copy of it.**
 *
 * This used to hand-roll the dispatcher — a `createServer`, an `upgrade`
 * handler, and a `try`/`catch` around `new URL` written to mirror `main.ts`'s
 * `pathOf` — with a comment saying so. Two things made that untenable rather
 * than merely duplicated: the dispatcher moved into `relay/listener.ts` so two
 * entry points could share it, and it grew a route (`/__relay/health`) whose
 * entire correctness is *which paths it does not take*. A fixture that
 * approximates the subject cannot assert that.
 *
 * `presence` is deliberately absent here: the writer is exercised directly, and
 * a flush timer on every case in this file would be a database write racing
 * every assertion about `stats()`.
 */
const registry = new TunnelRegistry();
const relayListener = createRelayListener({
  db,
  issuer: ISSUER,
  host: "127.0.0.1",
  port: 0,
  registry,
});
const relay = relayListener.server;

await listen(daemon);
await listening(relay);
const daemonPort = (daemon.address() as AddressInfo).port;
const relayPort = (relay.address() as AddressInfo).port;
const relayUrl = `http://127.0.0.1:${relayPort}`;

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

/** The half of `listen` for a server something else already told to listen. */
function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", () => resolve()));
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/*
 * Counters read by machine, never by position.
 *
 * `stats()` maps over the registry's `tunnels` Map, so it is insertion-ordered,
 * and the `tunnel identity` section above registers and terminates tunnels for
 * `m_other` whose relay-side unregister lands asynchronously. `stats()[0]` was
 * therefore only the tunnel under test by luck of timing — and when it was not,
 * "none of them touched the tunnel" would compare 0 to 0 on somebody else's
 * counter and pass without measuring anything.
 */
function proxied(machineId: string): number {
  return registry.stats().find((tunnel) => tunnel.machineId === machineId)?.requestsProxied ?? -1;
}

function activeStreams(machineId: string): number {
  return registry.stats().find((tunnel) => tunnel.machineId === machineId)?.activeStreams ?? -1;
}

async function relayFetch(path: string, token: string | null): Promise<{ status: number; body: string }> {
  const response = await fetch(new URL(path, relayUrl), {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.text() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTunnel(machineId: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registry.isOnline(machineId)) return true;
    await sleep(25);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * The backoff curve — pure, so it is checked without waiting on it
 * ------------------------------------------------------------------ */

process.stdout.write("\nreconnect backoff\n");
{
  // Full jitter: every delay lies in [0, window]. Driven with a fixed "random"
  // so the bounds are exact rather than probabilistic.
  const maxes = [1, 2, 3, 4, 5, 6, 10, 20].map((attempt) => reconnectDelayMs(attempt, () => 1));
  const mins = [1, 5, 20].map((attempt) => reconnectDelayMs(attempt, () => 0));
  check("full jitter can return zero", mins, [0, 0, 0]);
  check("the window doubles then caps", maxes, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  check("the cap is the documented one", maxes[maxes.length - 1], RECONNECT_MAX_MS);
  const spread = new Set(Array.from({ length: 200 }, () => reconnectDelayMs(6)));
  report("jitter actually spreads", spread.size > 100, `${spread.size} distinct delays in 200 draws`);
}

/* ------------------------------------------------------------------ *
 * Tunnel identity
 * ------------------------------------------------------------------ */

process.stdout.write("\ntunnel identity\n");

/** `version: null` omits the header entirely, which is what a pre-header daemon does. */
async function tryTunnel(key: string | null, version: string | null): Promise<number | "connected"> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (version !== null) headers[TUNNEL_VERSION_HEADER] = version;
    if (key !== null) headers["authorization"] = `Bearer ${key}`;
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${TUNNEL_PATH}`, { headers });
    ws.on("open", () => {
      ws.terminate();
      resolve("connected");
    });
    ws.on("unexpected-response", (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", () => resolve(0));
  });
}

/** The version the relay says it agreed to, read off the 101. */
async function agreedVersion(key: string, version: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (version !== null) headers[TUNNEL_VERSION_HEADER] = version;
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${TUNNEL_PATH}`, { headers });
    let seen: string | null = null;
    ws.on("upgrade", (res) => {
      const raw = res.headers[TUNNEL_AGREED_VERSION_HEADER];
      seen = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    });
    ws.on("open", () => {
      ws.terminate();
      resolve(seen);
    });
    ws.on("unexpected-response", () => {
      ws.terminate();
      resolve(null);
    });
    ws.on("error", () => resolve(null));
  });
}

check("no credential is refused", await tryTunnel(null, String(RELAY_PROTOCOL_VERSION)), 401);
check("a made-up credential is refused", await tryTunnel("tk_nonsense", String(RELAY_PROTOCOL_VERSION)), 401);
check("the real credential connects", await tryTunnel(myTunnelKey, String(RELAY_PROTOCOL_VERSION)), "connected");

/*
 * The protocol version is negotiated, and this block is the anti-flag-day
 * property written down as assertions.
 *
 * It used to be one line — version `99` answered `426` — because the relay
 * compared the daemon's version to its own with `!==`. That is a **flag day**: a
 * relay moved to v2 refuses every v1 daemon, and since the relay is the only way
 * into a machine, refusing them is the fleet switched off until the last laptop
 * has been updated by hand. On a project whose control plane ships weekly and
 * whose daemons are updated by whoever owns them, that is the one shape that
 * cannot be allowed to exist.
 *
 * So: newer offers are negotiated **down**, older ones are accepted until the
 * floor is deliberately raised past them, and only something outside the range
 * in the *low* direction is refused.
 */
check(
  "a daemon newer than this relay is negotiated down rather than refused",
  await tryTunnel(myTunnelKey, "99"),
  "connected",
);
check("and it is told what it was accepted as", await agreedVersion(myTunnelKey, "99"), String(RELAY_PROTOCOL_VERSION));
check(
  "a daemon too old for this relay's floor is refused",
  await tryTunnel(myTunnelKey, String(RELAY_PROTOCOL_MIN_VERSION - 1)),
  426,
);
check("a version that is not a number is refused", await tryTunnel(myTunnelKey, "banana"), 426);
/*
 * And no header at all, which is what every daemon built before the header
 * existed sends. Read as the floor rather than refused: that daemon speaks v1 by
 * definition, and refusing it would be the flag day arriving through the one
 * door left open.
 */
check("a daemon that predates the header connects", await tryTunnel(myTunnelKey, null), "connected");
/*
 * ⚠ **Against the literal 1, not against `RELAY_PROTOCOL_MIN_VERSION`.** This
 * assertion was written against the floor, which is the same number today and is
 * the *bug* rather than the property: read as the floor, a pre-header daemon is
 * taken to have offered whatever the floor currently is, so the day step 4 raises
 * it to 2 this daemon is negotiated to v2, accepted, and handed frames it has
 * never heard of — while this check stayed green and defended it. Silence means
 * "predates negotiation", which is 1 for ever.
 */
check(
  "and is read as speaking v1, the version that predates the header",
  await agreedVersion(myTunnelKey, null),
  "1",
);
check(
  "which is what PRE_NEGOTIATION_PROTOCOL_VERSION is, and it is not the floor by definition",
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  1,
);

/*
 * And that the dial leaves an inventory behind, which is the other half of not
 * having a flag day: a range is what makes a bump survivable, and knowing what is
 * still below the floor is what makes it *decidable*.
 *
 * Asserted through the socket rather than by calling `recordDaemonBuild`, because
 * the property is that the header survives the whole path — sent by the daemon,
 * read off the request, bounded, and written against the machine the credential
 * resolved to.
 */
{
  const withVersion = (version: string): Promise<number | "connected"> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${TUNNEL_PATH}`, {
        headers: {
          authorization: `Bearer ${myTunnelKey}`,
          [TUNNEL_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
          [DAEMON_VERSION_HEADER]: version,
        },
      });
      ws.on("open", () => {
        ws.terminate();
        resolve("connected");
      });
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate();
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => resolve(0));
    });

  const fleetRow = (): Record<string, unknown> => {
    const row = db
      .prepare("SELECT daemon_version, daemon_protocol, daemon_seen_at FROM machines WHERE id = ?")
      .get(mine);
    return (row ?? {}) as Record<string, unknown>;
  };

  await withVersion("9.9.9-test");
  check("the daemon's build is recorded against the machine that dialled", fleetRow()["daemon_version"], "9.9.9-test");
  check("with the protocol version that was agreed", fleetRow()["daemon_protocol"], RELAY_PROTOCOL_VERSION);
  check("and when it was seen", typeof fleetRow()["daemon_seen_at"], "number");

  /*
   * A daemon that sends no build at all is still a tunnel. This is the
   * pre-header daemon, which is every daemon in the fleet on the day this ships,
   * so treating a missing label as a refusal would be the flag day arriving
   * through the inventory instead of through the protocol.
   */
  await tryTunnel(myTunnelKey, String(RELAY_PROTOCOL_VERSION));
  check("a daemon that reports no build still connects, and records none", fleetRow()["daemon_version"], null);

  /*
   * The label is bounded and scrubbed, because it is a string from the far end
   * that lands in an admin table and a log line.
   */
  await withVersion(`${"v".repeat(200)}`);
  check(
    "an over-long build string is cut rather than stored whole",
    String(fleetRow()["daemon_version"] ?? "").length,
    MAX_DAEMON_VERSION_CHARS,
  );
  /*
   * The scrub is asserted on the function rather than through a socket, and the
   * reason is worth recording: Node's own HTTP client refuses to *send* a header
   * value holding a control character (`ERR_INVALID_CHAR`), so this case cannot
   * be driven from this end at all. That refusal binds this client and says
   * nothing about a peer written in anything else, so the strip stays and is
   * checked where it can be.
   */
  check(
    "a build string is scrubbed of control characters before it is stored",
    readDaemonVersionHeader("1.0\u0000\u001b[31m-injected"),
    "1.0[31m-injected",
  );
  check("and an empty one reads as no answer rather than as a version", readDaemonVersionHeader("   "), null);
  check("and a header nobody sent reads the same way", readDaemonVersionHeader(undefined), null);
  check("and an array-valued header takes its first entry", readDaemonVersionHeader(["1.2.3", "9"]), "1.2.3");

  /*
   * The CLI inventory beside it, under the same rule and with one deliberate
   * difference: a list is refused whole where a label is cut. Driven through the
   * socket for the same reason as the version — the property is that the header
   * survives the whole path — with the pure grammar asserted directly after.
   */
  const withClis = (clis: string | null): Promise<number | "connected"> =>
    new Promise((resolve) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${myTunnelKey}`,
        [TUNNEL_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
        [DAEMON_VERSION_HEADER]: "9.9.9-clis",
      };
      if (clis !== null) headers[AGENT_CLIS_HEADER] = clis;
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${TUNNEL_PATH}`, { headers });
      ws.on("open", () => {
        ws.terminate();
        resolve("connected");
      });
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate();
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => resolve(0));
    });
  const agentsRow = (): unknown => db.prepare("SELECT daemon_agents FROM machines WHERE id = ?").get(mine)?.["daemon_agents"];

  check("a daemon announcing its CLIs still connects", await withClis("claude=2.1.259;codex=0.153.1;kimi=-"), "connected");
  check("and the inventory is recorded against the machine that dialled", agentsRow(), "claude=2.1.259;codex=0.153.1;kimi=-");
  check("beside the build that sent it", fleetRow()["daemon_version"], "9.9.9-clis");

  check("a redial carrying a different inventory still connects", await withClis("claude=2.1.300"), "connected");
  check("and the newer one wins — the row is the last handshake, never the best one", agentsRow(), "claude=2.1.300");

  /* The pre-header daemon, which is every daemon in the fleet on the day this ships. */
  check("a daemon that announces no inventory still connects", await withClis(null), "connected");
  check("and is listed with none, replacing what an earlier dial said", agentsRow(), null);
  check("while its build is still recorded", fleetRow()["daemon_version"], "9.9.9-clis");

  /*
   * Refused to `null`, never to a refused dial. The tunnel is the only way to
   * reach the machine, and the header is a report.
   */
  await withClis("claude=2.1.300");
  check("a malformed inventory does not cost the dial", await withClis("claude=2.1;;codex"), "connected");
  check("and is refused whole rather than stored in part", agentsRow(), null);
  await withClis("claude=2.1.300");
  check("an over-long inventory does not cost the dial", await withClis(`claude=${"9".repeat(MAX_AGENT_CLIS_CHARS)}`), "connected");
  check("and is refused whole rather than cut — a cut list is a false version", agentsRow(), null);
  await withClis("claude=2.1.300");
  check("a duplicated harness does not cost the dial", await withClis("claude=1.0.0;claude=2.0.0"), "connected");
  check("and is refused, since two answers for one harness is no answer", agentsRow(), null);

  /* The grammar, with no socket. */
  check(
    "the grammar reads the compact form back into harness → version",
    parseAgentClis("claude=2.1.259;codex=0.153.1;kimi=-"),
    { claude: "2.1.259", codex: "0.153.1", kimi: null },
  );
  check("and formats it the same way round", formatAgentClis({ claude: "2.1.259", codex: "0.153.1", kimi: null }), "claude=2.1.259;codex=0.153.1;kimi=-");
  check("a prerelease tag is a version", parseAgentClis("opencode=1.0.0-beta.2"), { opencode: "1.0.0-beta.2" });
  check("an empty value is no inventory rather than an empty one", parseAgentClis(""), null);
  check("a dangling separator is refused", parseAgentClis("claude=2.1.259;"), null);
  check("an entry with no version is refused", parseAgentClis("claude"), null);
  check("an entry with an empty version is refused", parseAgentClis("claude="), null);
  check("an id outside the harness alphabet is refused", parseAgentClis("Claude=2.1.259"), null);
  check("a version with a space in it is refused", parseAgentClis("claude=2.1.259 (Claude Code)"), null);
  check("a control character has no room in the grammar, so there is no scrub to mirror", parseAgentClis("claude=2.1\u0000.259"), null);
  /* The length bound, with every entry well-formed, so it is the bound refusing and not the alphabet. */
  const entries = (n: number): string => Array.from({ length: n }, (_, i) => `h${String(i).padStart(3, "0")}=1`).join(";");
  check("the fixture sits either side of the bound", [entries(73).length <= MAX_AGENT_CLIS_CHARS, entries(74).length > MAX_AGENT_CLIS_CHARS], [true, true]);
  check("a list over the bound is refused", parseAgentClis(entries(74)), null);
  check("and one under it is read whole", Object.keys(parseAgentClis(entries(73)) ?? {}).length, 73);
  check("the header reader takes the first of an array-valued header", readAgentClisHeader(["kimi=0.40.1", "codex=1"]), "kimi=0.40.1");
  check("and trims what a proxy may pad", readAgentClisHeader("  kimi=0.40.1 "), "kimi=0.40.1");
  check("and a header nobody sent reads as no inventory", readAgentClisHeader(undefined), null);

  /*
   * The daemon's end of the same path, through a real `RelayTunnel`: the two ways
   * the announcement can fail that the header reader never sees, because they
   * happen before a socket exists. Neither may cost the dial — `tunnel.ts`'s first
   * property — and each lands on the same `null` as a daemon that never spoke.
   */
  const untilOffline = async (): Promise<void> => {
    const gone = Date.now() + 5_000;
    while (Date.now() < gone && registry.isOnline(mine)) await sleep(25);
  };
  const dialWith = async (options: { agentClis: () => Promise<Record<string, string | null>>; announceTimeoutMs?: number }): Promise<boolean> => {
    // The raw dials above terminate on `open`, and the relay unregisters them a
    // tick later — so "online" has to be *this* tunnel's, or the row read after
    // it is the raw dial's and the assertion passes for the wrong reason.
    await untilOffline();
    const probe = RelayTunnel.start({ relayUrl, tunnelKey: myTunnelKey, local: { host: "127.0.0.1", port: daemonPort }, ...options });
    const up = await waitForTunnel(mine);
    await probe.stop();
    await untilOffline();
    return up;
  };
  await withClis("claude=2.1.300");
  check(
    "an announcement that throws still dials",
    await dialWith({
      agentClis: async () => {
        throw new Error("no runtime");
      },
    }),
    true,
  );
  check("and records nothing", agentsRow(), null);
  await withClis("claude=2.1.300");
  check(
    "an announcement that never answers still dials, past the bound",
    await dialWith({ agentClis: () => new Promise(() => {}), announceTimeoutMs: 50 }),
    true,
  );
  check("and records nothing either", agentsRow(), null);
}

/* The pure half, asserted directly rather than through a socket. */
check("negotiation takes the newest both ends know", negotiateProtocolVersion(99), RELAY_PROTOCOL_VERSION);
check("and refuses what is below the floor", negotiateProtocolVersion(RELAY_PROTOCOL_MIN_VERSION - 1), null);
check("and refuses a fraction, which is not a version", negotiateProtocolVersion(1.5), null);
check("and refuses NaN, which is what a non-numeric header parses to", negotiateProtocolVersion(Number("x")), null);

/*
 * The property that matters most, stated as a test even though it is really a
 * statement about the shape of the protocol: there is no field anywhere in the
 * tunnel handshake that names a machine. A daemon cannot ask to be machine B; it
 * presents a credential and the relay looks up whose it is. So the only way to
 * hold machine B's tunnel is to hold machine B's secret.
 */
{
  const revoked = issueTunnelKey(db, other); // rotating `other` retires the previous key
  check("re-issuing retires the previous credential", await tryTunnel(otherTunnelKey, "1"), 401);
  check("the newly issued credential works", await tryTunnel(revoked, "1"), "connected");
}

/*
 * ⭐ **The dial, which is the half the whole `relayOnline` argument rests on.**
 *
 * `relay/authorize.ts` refusing a proxied request is asserted much further down,
 * against `relayFetch`. This is the *other* refusal, in `tunnel-endpoint.ts`, and
 * it was driven by nothing: `tryTunnel`'s call sites were a missing credential, a
 * made-up one, a wrong version, a real one and a rotated pair, so deleting the
 * check on the reasoning that "authorize already refuses it" left every
 * assertion in this file green.
 *
 * What that costs is the sentence the split exists to make: refused at dial a
 * suspended machine is `relayOnline: false` plus `overLimit: true`, which every
 * client draws and explains; allowed to dial it holds a tunnel and answers 403 to
 * every request, which presents as **online and broken** — indistinguishable from
 * a bug in the relay or the daemon.
 *
 * 403 and not 401 is pinned too, because that choice is load-bearing rather than
 * cosmetic: a daemon reading 401 is being told its credential is wrong, which
 * invites a re-enrollment that would not help and that rotates a perfectly good
 * tunnel key.
 *
 * `mine` has no ownership row in this fixture — it is the ownerless case — so the
 * block makes one and takes it away again, leaving the machine exactly as the
 * real tunnel below expects to find it.
 */
{
  const version = String(RELAY_PROTOCOL_VERSION);
  db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
    mine,
    alice,
    "dialled",
    Date.now(),
  );

  check("an ownerless machine dials, which is every machine predating ownership", await tryTunnel(myTunnelKey, version), "connected");

  writeMachineLimit(db, alice, 0, "u_admin");
  check("a machine over its owner's limit is refused at dial", await tryTunnel(myTunnelKey, version), 403);

  /*
   * The reversibility claim, and the reason suspension is derived rather than
   * written: nothing was re-enrolled, no key was rotated, and the daemon's own
   * backoff is the whole recovery path.
   */
  writeMachineLimit(db, alice, 5, "u_admin");
  check("raising the limit lets the same key dial again", await tryTunnel(myTunnelKey, version), "connected");

  /*
   * The sibling gate. One refusal for both, deliberately — a daemon has nothing
   * to do differently about them, and the distinction is for the person reading
   * a screen.
   */
  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(Date.now(), alice);
  check("a banned owner's daemon is refused at dial too", await tryTunnel(myTunnelKey, version), 403);
  db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(alice);

  clearMachineLimit(db, alice);
  db.prepare("DELETE FROM machine_owners WHERE machine_id = ?").run(mine);
  check("and it dials once more with all of that undone", await tryTunnel(myTunnelKey, version), "connected");
}

/* ------------------------------------------------------------------ *
 * A real tunnel, and everything that rides it
 * ------------------------------------------------------------------ */

const tunnel = RelayTunnel.start({
  relayUrl,
  tunnelKey: myTunnelKey,
  local: { host: "127.0.0.1", port: daemonPort },
  // What `scripts/daemon.ts` wires in, as a value: the tunnel everything below
  // rides announces an inventory, and the row is read once it is up.
  agentClis: async () => ({ claude: "2.1.259", codex: null }),
});

process.stdout.write("\nthe tunnel\n");
check("the tunnel comes up", await waitForTunnel(mine), true);
/*
 * Polled rather than read once: the section above ends on a raw dial that the
 * relay is still unregistering when this tunnel starts, so `waitForTunnel` can
 * answer for that one. The row is written before the handshake completes, so
 * once this tunnel is the one online the value is there.
 */
check(
  "carrying the CLI inventory the daemon resolved, in the header's compact form",
  await (async (): Promise<unknown> => {
    const deadline = Date.now() + 5_000;
    let seen: unknown = null;
    while (Date.now() < deadline) {
      seen = db.prepare("SELECT daemon_agents FROM machines WHERE id = ?").get(mine)?.["daemon_agents"];
      if (seen === "claude=2.1.259;codex=-") break;
      await sleep(25);
    }
    return seen;
  })(),
  "claude=2.1.259;codex=-",
);

process.stdout.write("\nauthorization, checked before a byte is forwarded\n");
{
  const before = proxied(mine);

  check("no token", (await relayFetch("/x", null)).status, 401);
  check("a token this control plane did not sign", (await relayFetch("/x", "not.a.token")).status, 401);
  check("a user with no grant", (await relayFetch("/x", tokenFor(mallory, mine))).status, 404);
  check("a disabled user", (await relayFetch("/x", tokenFor(disabled, mine))).status, 403);
  check("an expired token", (await relayFetch("/x", tokenFor(alice, mine, -1000))).status, 401);
  // Audience binding. `m_other` has no tunnel here, but the point is that this
  // token cannot reach `m_mine` no matter what — the route is the `aud` claim.
  check("a token minted for another machine", (await relayFetch("/x", tokenFor(alice, other))).status, 404);

  const after = proxied(mine);
  report("none of them touched the tunnel", before === after, `requestsProxied stayed at ${before}`);
}

/*
 * The browser's preflight.
 *
 * It carries no token — that is what a preflight is — so there is no `aud` to
 * read and no machine to route it to. The relay therefore answers it itself, and
 * the two things worth pinning are that it answers at all (without one, no
 * browser can reach any daemon on either path) and that answering does not look
 * like proxying: `requestsProxied` is how "the client went direct" stays a
 * measurement, and a counter that moved on preflights would quietly stop
 * measuring anything.
 */
process.stdout.write("\nCORS preflight\n");
{
  const before = proxied(mine);

  const preflight = await fetch(new URL("/sessions", relayUrl), {
    method: "OPTIONS",
    headers: {
      origin: "http://ui.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  check("answered without a token", preflight.status, 204);
  check("and allows the credential header", preflight.headers.get("access-control-allow-origin"), "*");
  report(
    "and the headers a session needs",
    (preflight.headers.get("access-control-allow-headers") ?? "").includes("authorization") &&
      (preflight.headers.get("access-control-allow-methods") ?? "").includes("POST"),
    preflight.headers.get("access-control-allow-headers") ?? "(none)",
  );

  // The whole set, not just the one verb this case happens to use. The relay and
  // the daemon must answer a preflight identically — a browser that preflights
  // against the relay and then talks to the daemon directly (or the reverse, on a
  // route change) would otherwise get two different answers about the same API.
  // `PUT` is named because it is the one that was missing: `PUT /agent-auth/:agent`
  // shipped while `CORS_ALLOW_METHODS` still read GET/POST/DELETE/OPTIONS, so the
  // paste-a-token path failed in a browser and nowhere else. `daemoncheck` asserts
  // the other direction — that no daemon route uses a verb this list withholds.
  const answered = (preflight.headers.get("access-control-allow-methods") ?? "")
    .split(",")
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0)
    .sort();
  check("the relay advertises exactly the shared method list", answered, [...CORS_ALLOW_METHODS].sort());

  // A refusal has to be readable too, or the client cannot tell "asleep" from
  // "your token expired" — they are the same opaque network error otherwise.
  const refused = await relayFetch("/x", null);
  check("a refusal is still a refusal", refused.status, 401);
  const refusedHeaders = await fetch(new URL("/x", relayUrl), { headers: { origin: "http://ui.example" } });
  check("and readable cross-origin", refusedHeaders.headers.get("access-control-allow-origin"), "*");

  // An OPTIONS that is *not* a preflight must still be forwarded: it is a method
  // a daemon could legitimately answer, and swallowing it here would be the relay
  // deciding what the daemon supports.
  const plainOptions = await fetch(new URL("/x", relayUrl), { method: "OPTIONS" });
  check("a bare OPTIONS is not treated as a preflight", plainOptions.status, 401);

  const after = proxied(mine);
  report("none of it touched the tunnel", before === after, `requestsProxied stayed at ${before}`);
}

/* ------------------------------------------------------------------ *
 * A request target the URL parser refuses
 *
 * llhttp and the WHATWG URL parser do not agree about what a request target is,
 * and `readToken` is where the disagreement was reachable **with no credential
 * at all**: it runs first on both `handleRequest` and `handleUpgrade`, before
 * `authorize`, against the one listener that has to face the internet for
 * daemons to dial in.
 *
 * Both halves of the disagreement are re-measured below rather than restated,
 * because either one moving makes the case vacuous: the HTTP parser has to
 * *accept* the target for any of this to be reachable, and `new URL` has to
 * *refuse* it for the guard to matter.
 *
 * Unguarded, that throw escaped the `'request'`/`'upgrade'` emit before anything
 * had written a response or destroyed the socket — `requestTimeout` is already
 * cleared by then and `keepAliveTimeout` only arms once a response is sent — so
 * `main.ts`'s `uncaughtException` backstop kept the process alive holding one
 * more leaked fd per unauthenticated line.
 *
 * **Reverting the guard does not merely redden these lines, it takes this driver
 * down with an uncaught exception**, which is exactly what it does to the
 * service minus the backstop that hides it there. Said out loud so the next
 * person reads the stack as this section firing rather than as the driver being
 * broken.
 * ------------------------------------------------------------------ */

process.stdout.write("\nan unparseable request target\n");
{
  const before = proxied(mine);

  // Hand-written, because `fetch` and `ws` both normalize the target through the
  // very parser this is about — there is no way to *send* one of these except on
  // a raw socket.
  const rawResponse = (target: string, extra: string[]): Promise<string> =>
    new Promise((resolve) => {
      let seen = "";
      const socket = netConnect(relayPort, "127.0.0.1", () => {
        socket.write([`GET ${target} HTTP/1.1`, `host: 127.0.0.1:${relayPort}`, ...extra, "", ""].join("\r\n"));
      });
      const done = (answer: string): void => {
        clearTimeout(bail);
        socket.destroy();
        resolve(answer);
      };
      // Nothing takes two seconds on loopback, and a hang here *is* the old
      // behaviour — no response and no close — so it is reported rather than
      // waited on.
      const bail = setTimeout(() => done("(no answer, and the socket is still open)"), 2_000);
      socket.on("data", (chunk: Buffer) => (seen += chunk.toString()));
      socket.on("close", () => done(seen === "" ? "(closed with nothing written)" : seen));
      socket.on("error", (error: Error) => done(`error ${error.message}`));
    });

  const parses = (target: string): string => {
    try {
      void new URL(target, "http://relay");
      return "parsed";
    } catch {
      return "refused";
    }
  };
  check("the URL parser refuses all three shapes", ["//%", "/\\", "//["].map(parses), [
    "refused",
    "refused",
    "refused",
  ]);

  const refused = await rawResponse("//%", ["connection: close"]);
  check("and the relay answers rather than holding the socket", refused.split("\r\n")[0], "HTTP/1.1 401 Unauthorized");
  /*
   * `missing_token` is the honest code and not a stand-in: there is no readable
   * credential in a target nothing can parse. It also puts the case on the
   * refusal path that already exists, so nothing new writes to the socket.
   */
  check("with the code that says there was no credential to read", refused.includes('"missing_token"'), true);
  check(
    "the other two shapes are answered the same way",
    [await rawResponse("/\\", ["connection: close"]), await rawResponse("//[", ["connection: close"])].map(
      (answer) => answer.split(" ")[1] ?? "(none)",
    ),
    ["401", "401"],
  );

  /*
   * The upgrade path, which is the one that matters most: `?token=` is how a
   * browser authenticates a WebSocket, so this is the code path where reading
   * the query string is not optional — and `refuseUpgrade` writes a status line
   * on the raw socket and destroys it, which is the release the leak was about.
   */
  const upgrade = await rawResponse("//%", [
    "upgrade: websocket",
    "connection: Upgrade",
    "sec-websocket-version: 13",
    `sec-websocket-key: ${randomBytes(16).toString("base64")}`,
  ]);
  check("an upgrade with the same target is refused too", upgrade.split("\r\n")[0], "HTTP/1.1 401 missing_token");

  // The guard answers `null` rather than swallowing the query branch, so a
  // target the parser *does* accept still hands its `?token=` over — which is
  // what `a websocket through the relay` below drives end to end.
  report("none of them touched the tunnel", proxied(mine) === before, `requestsProxied stayed at ${before}`);
}

process.stdout.write("\nkey rotation\n");
{
  /*
   * A rotation must be picked up even when an attacker has just warmed the
   * key-cache throttle with a nonsense `kid`.
   *
   * The two are indistinguishable when they arrive — both are cache misses — so a
   * throttle that is too coarse rejects genuinely valid tokens for as long as it
   * lasts. That was a real bug in this file's first version, caught here rather
   * than in production, which is the whole reason this case exists.
   */
  const rotated = generateKeyPairSync("ed25519");
  const jwk = publicKeyToJwk(rotated.publicKey);
  const rotatedKid = keyIdFor(jwk);
  db.prepare("INSERT INTO signing_keys (kid, private_pem, public_jwk, created_at) VALUES (?, ?, ?, ?)").run(
    rotatedKid,
    rotated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    JSON.stringify(jwk),
    Date.now(),
  );

  const seconds = Math.floor(Date.now() / 1000);
  const freshlySigned = signToken(
    {
      iss: ISSUER,
      sub: alice,
      aud: mine,
      jti: newId("t"),
      iat: seconds,
      nbf: seconds,
      exp: seconds + 300,
      scp: ["session:read"],
    },
    rotatedKid,
    rotated.privateKey,
  );

  // Warm the throttle with an unknown kid first, exactly as a flood would.
  check("an unknown key is refused", (await relayFetch("/x", tokenFor(alice, mine).replace(/^[^.]+/, "eyJhbGciOiJFZERTQSIsInR5cCI6InJlbW9zbG9wK2p3dCIsImtpZCI6Il9ub25lXyJ9"))).status, 401);
  await sleep(1_100);
  check("a token signed by a newly added key is accepted", (await relayFetch("/sessions", freshlySigned)).status, 200);
}

process.stdout.write("\nforwarding\n");
{
  const ok = await relayFetch("/sessions?x=1", tokenFor(alice, mine));
  check("an authorized request reaches the daemon", ok.status, 200);
  check("the path arrives intact", JSON.parse(ok.body).path, "/sessions?x=1");

  /*
   * Nothing in the relay's own namespace reaches the daemon's HTTP layer, from
   * either direction.
   *
   * The relay's advisory `reemoat-sub` rides the CONNECT headers and stops at
   * the daemon's tunnel code, and a client-supplied copy is stripped before
   * forwarding. So the daemon's request handling sees this namespace as empty no
   * matter who tried to fill it — which is what makes the reserved headers safe
   * to extend later without re-auditing what a caller could smuggle through.
   */
  check("relay metadata stays on the tunnel, out of the request", JSON.parse(ok.body).subject, null);

  const forged = await fetch(new URL("/sessions", relayUrl), {
    headers: { authorization: `Bearer ${tokenFor(alice, mine)}`, "reemoat-sub": "u_root" },
  });
  const forgedBody = (await forged.json()) as { subject: string | null };
  check("a client-supplied relay header is stripped", forgedBody.subject, null);
}

/* ------------------------------------------------------------------ *
 * A WebSocket through the relay — a WebSocket inside a WebSocket
 * ------------------------------------------------------------------ */

/*
 * The path the relay mostly carries, and the one with the least code behind it.
 *
 * `/sessions/:id/stream` is where a browser spends its whole session, and the
 * claim it rests on is that tunnelling it needed no special case: the tunnel
 * carries opaque bytes, so `proxy.handleUpgrade` replays a raw 101 onto the
 * client socket and then pipes. "No special case" is a pleasant thing to believe
 * and a bad thing to assume, because the parts that are hand-written here — the
 * status line, the `rawHeaders` replay, the `head` buffer, the two pipes — are
 * exactly the parts a framework is not checking for us.
 *
 * The browser cannot set headers on a WebSocket handshake, so the token rides as
 * `?token=`, which also exercises `readToken`'s query-string branch under a real
 * upgrade rather than a synthetic request.
 */
process.stdout.write("\na websocket through the relay\n");
{
  const before = proxied(mine);

  const wsUrl = (token: string | null): string => {
    const url = new URL("/stream", relayUrl);
    url.protocol = "ws:";
    if (token !== null) url.searchParams.set("token", token);
    return url.toString();
  };

  // An upgrade with no token must be refused by the relay, before any tunnel
  // stream is opened — the same rule as the request path, on the path where the
  // credential arrives somewhere else entirely.
  const refused = await new Promise<string>((resolve) => {
    const ws = new WebSocket(wsUrl(null));
    ws.on("open", () => {
      ws.close();
      resolve("opened");
    });
    ws.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on("error", (error: Error) => resolve(`error ${error.message}`));
  });
  check("an unauthorized upgrade is refused", refused, "http 401");

  const unauthorized = proxied(mine);
  report("and never reached the tunnel", before === unauthorized, `requestsProxied stayed at ${before}`);

  const frames = await new Promise<string[]>((resolve) => {
    const seen: string[] = [];
    const ws = new WebSocket(wsUrl(tokenFor(alice, mine)));
    const done = (): void => {
      ws.close();
      resolve(seen);
    };
    // Nothing should take five seconds on loopback; this is here so a regression
    // reports a missing frame rather than hanging the whole driver.
    const bail = setTimeout(done, 5_000);
    ws.on("open", () => ws.send("ping through the tunnel"));
    ws.on("message", (data: Buffer) => {
      seen.push(data.toString());
      if (seen.length === 2) {
        clearTimeout(bail);
        done();
      }
    });
    ws.on("error", (error: Error) => {
      clearTimeout(bail);
      seen.push(`error ${error.message}`);
      resolve(seen);
    });
  });

  check("the 101 is replayed and the daemon's first frame arrives", JSON.parse(frames[0] ?? "null"), {
    type: "hello",
    token: "present",
  });
  check("and a frame sent by the client comes back", JSON.parse(frames[1] ?? "null"), {
    type: "echo",
    text: "ping through the tunnel",
  });

  const after = proxied(mine);
  report("the authorized upgrade took exactly one stream", after - unauthorized === 1, `${after - unauthorized}`);

  // A tunnel that carried a WebSocket must still be an ordinary tunnel
  // afterwards: an upgrade holds its h2 stream open for the socket's whole life,
  // so a leak here would show as the next request never being answered.
  await sleep(50);
  check("the tunnel still serves ordinary requests", (await relayFetch("/sessions", tokenFor(alice, mine))).status, 200);
  report(
    "and the upgrade's stream was released",
    activeStreams(mine) === 0,
    `activeStreams ${activeStreams(mine)}`,
  );
}

/* ------------------------------------------------------------------ *
 * Flow control — the case this file exists for
 * ------------------------------------------------------------------ */

process.stdout.write("\nflow control\n");
{
  floodWritten = 0;

  /*
   * One client asks for an endless response and then never reads it.
   *
   * With credit-based flow control granted on *consumption*, the daemon is
   * stopped after roughly one stream window plus whatever the sockets on either
   * side hold, and stays stopped. Without it, `floodWritten` climbs until
   * something dies.
   */
  const stalled = await new Promise<{ destroy: () => void }>((resolve) => {
    const req = httpGet(
      new URL("/flood", relayUrl),
      { headers: { authorization: `Bearer ${tokenFor(alice, mine)}` } },
      (res) => {
        res.pause(); // the phone on bad LTE
        resolve({ destroy: () => res.destroy() });
      },
    );
    req.on("error", () => resolve({ destroy: () => {} }));
  });

  await sleep(1_200);
  const parked = floodWritten;

  /*
   * The bound. Generous on purpose — it is the sum of one h2 stream window, the
   * connection window, and the kernel buffers of two loopback sockets — because
   * the assertion worth making is "bounded", not a specific number that would
   * turn every buffer-size change into a failing test.
   */
  const bound = MAX_TUNNEL_BUFFERED_BYTES + STREAM_WINDOW_BYTES + 8 * 1024 * 1024;

  /*
   * Guard against a vacuous pass.
   *
   * "The sender stopped" is only meaningful if the sender started. A broken
   * `/flood`, a refused request or a stream that never opened would all park at
   * zero bytes and sail through the bound below while testing nothing at all —
   * which, for the one case this file exists for, would be worse than having no
   * test.
   */
  report("the flood actually ran", parked > STREAM_WINDOW_BYTES, `${parked} bytes written before parking`);

  report(
    "a stalled consumer stops the sender",
    parked < bound,
    `${(parked / 1024 / 1024).toFixed(1)} MiB written, bound ${(bound / 1024 / 1024).toFixed(0)} MiB`,
  );

  await sleep(800);
  report(
    "and it stays stopped",
    floodWritten === parked,
    floodWritten === parked ? "no further growth" : `grew by ${floodWritten - parked} bytes`,
  );

  /*
   * The other half of the requirement: the stalled stream must not have stalled
   * anybody else. This request shares the one tunnel with it.
   */
  const started = Date.now();
  const healthy = await relayFetch("/sessions", tokenFor(alice, mine));
  const elapsed = Date.now() - started;
  check("a second client still works while the first is stalled", healthy.status, 200);
  report("and is not slowed by it", elapsed < 1_000, `${elapsed}ms`);

  /*
   * ⭐ **The inbound bound, which every test above this one structurally cannot
   * reach.**
   *
   * Everything asserted so far is h2 flow control, and h2 sees a byte only after
   * `ws` has finished assembling a whole message. So a daemon that sends a
   * fragmented message and never sets FIN consumes no window, trips no valve, and
   * keeps answering pings while `ws` accumulates fragments — at `ws`'s default of
   * 100 MiB per message, in the one process holding every tunnel in the fleet.
   * `MAX_TUNNEL_BUFFERED_BYTES` does not cover it either: `bufferedAmount` is data
   * not yet **sent**.
   *
   * Asserted against the source rather than by flooding a real tunnel, and
   * deliberately: driving it would mean parking megabytes to prove a limit that
   * is one option, while the regression this guards against is somebody deleting
   * that option. Same technique `webcheck` uses on `SignIn` and `cpctl` — read
   * the file and assert what it says.
   */
  /*
   * ⭐ **Retiring a signing key has to take effect in a running relay.**
   *
   * The key cache refreshed only on a *miss*, which makes rotation work and makes
   * retirement silently not work. The documented order is `rotatekey` — both keys
   * published — then re-enroll the fleet, then `retirekey <old>`. After the
   * rotation the cache holds both keys, so the retired `kid` stays a hit, nothing
   * ever triggers a refresh, and tokens signed by it keep verifying until the
   * process restarts. The one command whose whole purpose is to stop a key
   * working did nothing.
   *
   * Driven through the real authorizer against the real table, and the sleep is
   * the assertion's other half: `KEY_REFRESH_MS` is the flood bound, so the point
   * is that the key stops working *on that clock* rather than never.
   */
  {
    const keyDb = new DatabaseSync(":memory:");
    applyControlPlaneSchema(keyDb);
    const first = ensureSigningKey(keyDb);
    keyDb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_k', 'kate', 1, ?)").run(Date.now());
    keyDb.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_k', 'kbox', ?)").run(Date.now());
    keyDb
      .prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES ('u_k','m_k','session:read',?)")
      .run(Date.now());

    const authorizer = createRelayAuthorizer(keyDb, ISSUER);
    const seconds = Math.floor(Date.now() / 1000);
    const signed = signToken(
      {
        iss: ISSUER,
        sub: "u_k",
        aud: "m_k",
        jti: newId("t"),
        iat: seconds,
        nbf: seconds,
        exp: seconds + 300,
        scp: ["session:read"],
      },
      first.kid,
      first.privateKey,
    );
    check("a token signed by the live key is authorized", authorizer.authorize(signed).ok, true);

    /*
     * The documented order, and both steps matter to the bug. `rotatekey`
     * publishes a second key **beside** the first — that is what lets a fleet
     * re-enroll without going dark — and it is also what put the old key in this
     * cache as a *hit*, so nothing after it ever triggered a refresh.
     * `retirekey` is refused on the last active key, so the rotation is not
     * optional setup here: it is the state the defect lives in.
     */
    mintSigningKey(keyDb);
    check("retiring the only key is refused, so a rotation comes first", retireSigningKey(keyDb, first.kid).ok, true);

    await sleep(KEY_REFRESH_MS + 50);
    const after = authorizer.authorize(signed);
    check("and a retired key stops authorizing without a restart", after.ok, false);
    check("with the code that says the key is the problem", after.ok ? "(none)" : after.code, "unknown_key");
    keyDb.close();
  }

  {
    const endpoint = readFileSync(
      new URL("../packages/control-plane/src/relay/tunnel-endpoint.ts", import.meta.url),
      "utf8",
    );
    const construction = /new WebSocketServer\(\{[\s\S]*?\}\)/.exec(endpoint)?.[0] ?? "";
    check("the tunnel socket caps the message it will assemble", /maxPayload:/.test(construction), true);
    check("at the shared constant rather than a number written twice", /maxPayload: MAX_TUNNEL_MESSAGE_BYTES/.test(construction), true);
    // The bound has to be reachable-but-generous: below any legitimate coalesced
    // write and this closes healthy tunnels instead of hostile ones.
    report(
      "and that constant is at or above one connection window",
      MAX_TUNNEL_MESSAGE_BYTES >= CONNECTION_WINDOW_BYTES,
      `${MAX_TUNNEL_MESSAGE_BYTES} against ${CONNECTION_WINDOW_BYTES}`,
    );
  }

  // Closing one stream must not disturb the others.
  stalled.destroy();
  await sleep(200);
  const afterClose = await relayFetch("/sessions", tokenFor(alice, mine));
  check("closing a stream leaves the tunnel healthy", afterClose.status, 200);
}

/* ------------------------------------------------------------------ *
 * The other half of flow control — a client that reads
 * ------------------------------------------------------------------ */

process.stdout.write("\na client that reads\n");
{
  /*
   * The mirror of the case above, and the half that was never asserted.
   *
   * The stalled-consumer case proves the **brake**: a client that stops reading
   * stops the sender, and stays stopped. It says nothing about the accelerator —
   * that a client which *does* read gets a body longer than one window at all.
   * Every window past the first depends on the `WINDOW_UPDATE` that consumption
   * is supposed to produce, so a regression into the yamux shape Q6.36 records
   * would fail here and nowhere else. Asserting only the brake is how a tunnel
   * that never replenishes anything would have looked perfect.
   *
   * ⚠ **A regression guard, not a reproduction.** This shape was run against the
   * relay's real topology well over a hundred times, on both Node 24 and Node 26,
   * and never failed — including with `setLocalWindowSize` deleted from one end
   * and from both. It does not reproduce the stall recorded in Q6.104.
   */
  const want = 4 * STREAM_WINDOW_BYTES;
  const started = Date.now();
  const got = await new Promise<number>((resolve) => {
    let bytes = 0;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(bytes);
    };
    const req = httpGet(
      new URL(`/flood?bytes=${want}`, relayUrl),
      { headers: { authorization: `Bearer ${tokenFor(alice, mine)}` } },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("close", done);
      },
    );
    req.on("error", done);
    const timer = setTimeout(() => {
      req.destroy();
      done();
    }, 10_000);
  });
  const elapsed = Date.now() - started;

  check("a reading client gets a body several windows long", got, want);
  report("and does not sit waiting on credit", got === want && elapsed < 5_000, `${want} bytes in ${elapsed}ms`);
}

/* ------------------------------------------------------------------ *
 * An upstream that dies mid-body
 * ------------------------------------------------------------------ */

process.stdout.write("\nan upstream that dies mid-body\n");
{
  /*
   * ⚠ **The bound fired and reached nobody.**
   *
   * `upstream.setTimeout` is armed on every proxied request, and the comment
   * beside it claimed that destroying the request "lands on the `error` handler
   * below". That holds only *before* `writeHead`: once the response has started,
   * `ClientRequest.destroy()` with no argument emits no `'error'`, so nothing
   * destroyed `res`, and the browser kept an open response whose `content-length`
   * promised bytes nobody was going to send. Measured: the bound fired at
   * +2017ms and the client was still waiting at +12s. The same hole swallowed
   * *every* mid-body upstream death, a tunnel drop included — `pipe` forwards
   * `end` and never a premature close.
   *
   * That is the whole distance between "the transcript failed, retry" — which
   * `isReplayable` already handles for a `GET` — and a spinner with no end,
   * which is what it looked like in the browser. Q6.103.
   *
   * Its own relay with a short `upstreamTimeoutMs`, for the reason the wedged
   * daemon below gives: the real number is two minutes, and a driver that spent
   * two minutes to watch it would not assert it at all.
   */
  const halfRegistry = new TunnelRegistry();
  const halfListener = createRelayListener({
    db,
    issuer: ISSUER,
    host: "127.0.0.1",
    port: 0,
    registry: halfRegistry,
    upstreamTimeoutMs: 300,
  });
  await listening(halfListener.server);
  const halfUrl = `http://127.0.0.1:${(halfListener.server.address() as AddressInfo).port}`;

  const halfTunnel = RelayTunnel.start({
    relayUrl: halfUrl,
    tunnelKey: myTunnelKey,
    local: { host: "127.0.0.1", port: daemonPort },
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !halfRegistry.isOnline(mine)) await sleep(25);
  check("the tunnel to the half-answering daemon is up", halfRegistry.isOnline(mine), true);

  const started = Date.now();
  const ended = await new Promise<{ how: string; bytes: number }>((resolve) => {
    let bytes = 0;
    let settled = false;
    const done = (how: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ how, bytes });
    };
    const req = httpGet(
      new URL("/halfbody", halfUrl),
      { headers: { authorization: `Bearer ${tokenFor(alice, mine)}` } },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        /*
         * `complete` rather than the event, because a *clean* end here is the
         * other way of failing: a body short of its own `content-length` that
         * says nothing about it is a truncated transcript a client would take
         * for a whole one.
         */
        res.on("close", () => done(res.complete ? "ended whole" : "aborted"));
        res.on("error", () => done("aborted"));
      },
    );
    req.on("error", () => done("aborted"));
    const timer = setTimeout(() => {
      req.destroy();
      done("still hanging");
    }, 4_000);
  });
  const waited = Date.now() - started;

  report(
    "a daemon that dies mid-body does not hang the browser",
    ended.how === "aborted",
    `${ended.how} after ${waited}ms with ${ended.bytes} bytes`,
  );
  report(
    "and the bound is what ends it, not the client giving up",
    ended.how === "aborted" && waited < 3_000,
    `${waited}ms`,
  );

  await halfTunnel.stop();
  halfListener.close();
}

/* ------------------------------------------------------------------ *
 * Losing the tunnel
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * Superseding a tunnel
 *
 * A documented invariant with a real defect history and, until now, no coverage:
 * the driver never had two tunnels for one machine alive at the same time, so
 * neither the supersede path nor the identity check in `unregister` ever ran.
 *
 * Done at the registry level with h2 sessions over a `PassThrough` — a session
 * that is open and going nowhere — so there is no timing in it at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsuperseding a tunnel\n");
{
  const parked = (): ClientHttp2Session => h2connect("http://tunnel", { createConnection: () => new PassThrough() });
  const sessionA = parked();
  const sessionB = parked();
  const first = new EndpointTunnel("m_super", Date.now(), RELAY_PROTOCOL_VERSION, sessionA, () => sessionA.destroy());
  const second = new EndpointTunnel("m_super", Date.now() + 1, RELAY_PROTOCOL_VERSION, sessionB, () => sessionB.destroy());

  registry.register(first, CLOSE_TUNNEL_SUPERSEDED);
  registry.register(second, CLOSE_TUNNEL_SUPERSEDED);
  /*
   * Newest wins. After a partition a daemon reconnects while the relay still holds
   * a socket it cannot know is dead, so refusing the new one would strand the
   * machine until a TCP timeout that may never come.
   */
  report("the newest tunnel wins", registry.get("m_super") === second, "the second registration is the live one");
  check("and one machine holds exactly one tunnel", registry.stats().filter((t) => t.machineId === "m_super").length, 1);

  /*
   * The matching half. The superseded tunnel's `close` fires *after* its
   * replacement registered, so an unconditional delete here would unregister the
   * healthy one and leave the machine offline with a live socket nobody can find.
   */
  registry.unregister(first);
  report("a late close from the superseded one does not unregister the replacement", registry.isOnline("m_super"), "still online");

  registry.unregister(second);
  check("and the registered one still unregisters", registry.isOnline("m_super"), false);
  sessionA.destroy();
  sessionB.destroy();
}

/* ------------------------------------------------------------------ *
 * One caller's share of a tunnel
 *
 * `MAX_CONCURRENT_STREAMS` is per tunnel and **a grant is full access to the
 * machine**, so it was a shared budget with no shares in it: anybody granted a
 * machine could hold all 256 — 256 attaches is a loop, not an attack — and the
 * machine's own owner would then be refused `503 no_tunnel`, which
 * `meansMachineGone` turns into "not reachable". A person watching their own
 * laptop go dark while it sits there running is the worst possible reading of a
 * resource limit, and it is the reading this produced.
 *
 * Driven on the tunnel rather than through the proxy, because the subject is the
 * whole subject: the proxy passes a verified `sub` straight through, and what is
 * being asserted is that two of them are two budgets.
 * ------------------------------------------------------------------ */

process.stdout.write("\none caller's share of a tunnel\n");
{
  /*
   * A peer that **discards** rather than a `PassThrough`, which is what the
   * blocks above use.
   *
   * A `PassThrough` echoes the client's own frames back at it. That is harmless
   * while nothing opens a stream — the sessions in "superseding a tunnel" never
   * do — and becomes `ERR_HTTP2_ERROR: Protocol error` the moment one does,
   * because the session receives its own preface as if the server had sent it.
   * What this case needs is a socket that accepts writes and says nothing, which
   * is exactly what a tunnel with no daemon reading looks like.
   */
  const nowhere = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const session = h2connect("http://tunnel", { createConnection: () => nowhere });
  session.on("error", () => {});
  const shared = new EndpointTunnel("m_share", Date.now(), RELAY_PROTOCOL_VERSION, session, () => session.destroy());

  /*
   * An `error` listener per stream, before anything can close one. These are h2
   * streams on a session whose peer is a `PassThrough` that answers nothing, so
   * tearing one down emits `ECONNRESET` — and an `error` with no listener is an
   * uncaught exception, which is the same rule `handleUpgrade` follows for the
   * raw socket and for the same reason.
   */
  const hold = (subject: string): ClientHttp2Stream | null => {
    const stream = shared.open(subject);
    stream?.on("error", () => {});
    return stream;
  };

  const held = [];
  for (let i = 0; i < MAX_STREAMS_PER_SUBJECT; i += 1) held.push(hold("u_greedy"));
  check("a caller may hold its whole share", held.filter((stream) => stream !== null).length, MAX_STREAMS_PER_SUBJECT);
  check("and is refused the one past it", hold("u_greedy"), null);

  /*
   * The half that is the point. Without a per-subject map this is the request
   * that would have been refused too — on the owner's own machine, with a daemon
   * that is perfectly healthy on the other end.
   */
  report("while somebody else is unaffected", hold("u_owner") !== null, "the owner still gets a stream");

  /*
   * And the budget is returned, not spent for the life of the tunnel. A counter
   * that only went up would turn a busy afternoon into a machine that stops
   * answering and never starts again.
   */
  held[0]?.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  report("a closed stream gives the slot back", hold("u_greedy") !== null, "the slot returned on close");

  shared.close(1000, "done");
  session.destroy();
}

/* ------------------------------------------------------------------ *
 * Revocation, on the path that reads live rows
 *
 * The relay's headline claim over a plain tunnel: it checks the caller's grant
 * before a byte is forwarded, and because it reads live rows a revocation takes
 * effect immediately rather than at the end of a token lifetime. Nothing
 * exercised it — every principal here had its rows fixed at startup.
 * ------------------------------------------------------------------ */

process.stdout.write("\nrevocation, immediately\n");
{
  const before = proxied(mine);
  const token = tokenFor(alice, mine);
  check("authorized while the grant exists", (await relayFetch("/sessions", token)).status, 200);

  // The same token, still unexpired and still perfectly signed. The direct path
  // would keep accepting it for its whole lifetime; the relay reads the row.
  db.prepare("DELETE FROM grants WHERE user_id = ? AND machine_id = ?").run(alice, mine);
  check("and refused the moment the grant is gone", (await relayFetch("/sessions", token)).status, 404);

  // No grant and a grant carrying nothing usable are different answers, and an
  // operator has to be able to tell them apart.
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, '', ?)").run(
    alice,
    mine,
    Date.now(),
  );
  check("a grant with no usable scopes is 403, not 404", (await relayFetch("/sessions", token)).status, 403);

  db.prepare("UPDATE grants SET scopes = 'session:read session:write' WHERE user_id = ? AND machine_id = ?").run(alice, mine);
  db.prepare("UPDATE machines SET revoked_at = ? WHERE id = ?").run(Date.now(), mine);
  // A revoked machine answers exactly as an unknown one, so holding a token
  // cannot be used to enumerate which machines exist.
  check("a revoked machine is indistinguishable from an unknown one", (await relayFetch("/sessions", token)).status, 404);

  db.prepare("UPDATE machines SET revoked_at = NULL WHERE id = ?").run(mine);
  check("and un-revoking restores the path", (await relayFetch("/sessions", token)).status, 200);
  report("only the two authorized requests touched the tunnel", proxied(mine) - before === 2, `${proxied(mine) - before} streams`);
}

/* ------------------------------------------------------------------ *
 * Over the machine limit, immediately
 *
 * The same shape as revocation above, and the same reason for being here rather
 * than beside the route tests: this is the only place a live tunnel, a real
 * token and the actual authorizer exist together, and "the machine stops
 * working" is a claim about all three.
 * ------------------------------------------------------------------ */

process.stdout.write("\nover the machine limit, immediately\n");
{
  const before = proxied(mine);
  const token = tokenFor(alice, mine);

  // `mine` has no ownership row in this fixture, which is the ownerless case —
  // so give it one, with alice as the owner, for the length of this block.
  db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
    mine,
    alice,
    "relaymine",
    Date.now(),
  );

  check("authorized while they are within their limit", (await relayFetch("/sessions", token)).status, 200);

  /*
   * ⭐ **The whole feature, through the real authorizer.** The same token, still
   * signed and unexpired — only the number moved.
   */
  writeMachineLimit(db, alice, 0, "u_admin");
  const refused = await relayFetch("/sessions", token);
  check("and refused the moment their limit drops below it", refused.status, 403);
  report(
    "with a code that says which of the reversible states this is",
    refused.body.includes("machine_over_limit"),
    refused.body.slice(0, 120),
  );
  report(
    "and a sentence naming the remedy, because the owner is the one who can act",
    refused.body.includes("nothing has been deleted"),
    refused.body.slice(0, 200),
  );

  /*
   * ⭐ **The enumeration oracle, and the assertion nothing else in this file
   * would catch.** Asked *before* the grant, this check turns any valid token
   * into a probe for "does machine X exist and is its owner over their limit".
   * A caller with no grant must get the same 404 an unknown machine gives.
   */
  const stranger = addUser("u_overlimit_stranger");
  check(
    "a caller with no grant still gets the shared 404, not a policy 403",
    (await relayFetch("/sessions", tokenFor(stranger, mine))).status,
    404,
  );

  /*
   * ⭐ **Raising it un-suspends, with the same token and no other act.** A
   * design that stored a suspended flag passes everything above and fails here.
   */
  writeMachineLimit(db, alice, 5, "u_admin");
  check("raising the limit restores the path, same token, nothing else touched", (await relayFetch("/sessions", token)).status, 200);

  /* -- the owner's ban, which is the same shape and a different code ------- */

  {
    /*
     * ⭐ **Banning somebody used to stop them signing in and stop nothing
     * else.** `authorize` reads `disabled_at` for the *caller*; nothing anywhere
     * read it for the **owner**. So every machine a banned person owned went on
     * working for anybody holding a grant, and their daemons went on holding
     * tunnels.
     *
     * Driven through a grantee, because that is the only caller who can reach
     * it: a banned owner cannot get past `callerAuth` to ask for anything.
     */
    const grantee = addUser("u_overlimit_grantee");
    grant(grantee, mine);
    const granteeToken = tokenFor(grantee, mine);
    check("a grantee reaches it while the owner is in good standing", (await relayFetch("/sessions", granteeToken)).status, 200);

    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(Date.now(), alice);
    const refusedByBan = await relayFetch("/sessions", granteeToken);
    check("and is refused the moment the owner is banned", refusedByBan.status, 403);
    /*
     * ⭐ **The code is `owner_disabled` and emphatically not `user_disabled`.**
     *
     * The client ends a session on `user_disabled` — correctly, it means "you
     * are banned". Reusing it here would sign a perfectly good grantee out of
     * the whole app for touching somebody else's suspended machine. Two facts,
     * two codes; `webcheck` asserts the other half, that only one of them ends
     * a session.
     */
    report(
      "with a code about the owner rather than about the caller",
      refusedByBan.body.includes("owner_disabled") && !refusedByBan.body.includes("user_disabled"),
      refusedByBan.body.slice(0, 140),
    );

    // ⭐ And it is the reversible remedy: nothing was revoked, so lifting the ban
    // restores the path with the same token and nobody touching a host.
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(alice);
    check("lifting the ban restores it, same token", (await relayFetch("/sessions", granteeToken)).status, 200);
    check(
      "and the machine was never revoked to achieve any of that",
      db.prepare("SELECT revoked_at FROM machines WHERE id = ?").get(mine)?.["revoked_at"],
      null,
    );
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(grantee);
  }

  clearMachineLimit(db, alice);
  db.prepare("DELETE FROM machine_owners WHERE machine_id = ?").run(mine);
  // Four authorized requests across both gates; every refusal must have been
  // decided before a stream was opened.
  report("only the authorized requests touched the tunnel", proxied(mine) - before === 4, `${proxied(mine) - before} streams`);
}

/* ------------------------------------------------------------------ *
 * The reserved encryption seam
 *
 * `reemoat-enc` is negotiated per stream and an unrecognised value is a *stream*
 * error, not a tunnel one — so an old daemon meeting a new relay loses one request
 * instead of going offline. The relay only ever sends `none`, so the branch is
 * reachable only by opening a stream by hand, and what is being pinned is the
 * blast radius rather than the feature.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe reserved encryption seam\n");
{
  const live = registry.get(mine);
  const session = (live as unknown as { session: ClientHttp2Session }).session;
  const statusOf = (headers: Record<string, string>): Promise<number> =>
    new Promise((resolve) => {
      const stream = session.request(headers);
      stream.on("response", (h) => resolve(Number(h[":status"] ?? 0)));
      stream.on("error", () => resolve(0));
      setTimeout(() => resolve(-1), 2_000).unref();
    });

  check(
    "an unknown encryption mode costs one stream, not the tunnel",
    await statusOf({
      ":method": "CONNECT",
      ":authority": "daemon",
      [STREAM_VERSION_HEADER]: String(RELAY_PROTOCOL_VERSION),
      [STREAM_ENCRYPTION_HEADER]: "aes-256-gcm",
      [STREAM_SUBJECT_HEADER]: alice,
    }),
    501,
  );
  /*
   * And the arm that actually matters, which nothing reached.
   *
   * ⚠ The per-stream version check is `!== this.agreedVersion`, and every driver
   * drove it with `RELAY_PROTOCOL_VERSION` on both sides — so the *equal* arm was
   * exercised and the disagreeing one never was. That is the arm the whole
   * negotiation rides on: a relay that stamps a stream with a version this tunnel
   * did not agree costs one request, and must not cost the tunnel. Driven with a
   * number no build will ever speak, so it stays a disagreement whatever
   * `RELAY_PROTOCOL_VERSION` becomes.
   */
  check(
    "a stream version the tunnel did not agree costs one stream, not the tunnel",
    await statusOf({
      ":method": "CONNECT",
      ":authority": "daemon",
      [STREAM_VERSION_HEADER]: "99",
      [STREAM_ENCRYPTION_HEADER]: STREAM_ENCRYPTION_NONE,
      [STREAM_SUBJECT_HEADER]: alice,
    }),
    501,
  );
  check(
    "and one that is not a number at all is refused the same way",
    await statusOf({
      ":method": "CONNECT",
      ":authority": "daemon",
      [STREAM_VERSION_HEADER]: "banana",
      [STREAM_ENCRYPTION_HEADER]: STREAM_ENCRYPTION_NONE,
      [STREAM_SUBJECT_HEADER]: alice,
    }),
    501,
  );
  check(
    "and a non-CONNECT stream is a 405",
    await statusOf({ ":method": "GET", ":path": "/", ":scheme": "http", ":authority": "daemon" }),
    405,
  );
  report("the tunnel is still up", registry.isOnline(mine), "online");
  check("and still serving", (await relayFetch("/sessions", tokenFor(alice, mine))).status, 200);
}

/* ------------------------------------------------------------------ *
 * What a stream is stamped with
 *
 * ⚠ **`open()` used to send `RELAY_PROTOCOL_VERSION` — this build's maximum —
 * and nothing anywhere compared that to what the handshake actually agreed.**
 * Every driver drove both ends with the same constant, so the two were equal by
 * construction and the disagreement was unreachable.
 *
 * What it cost is the whole point of the range: with the relay at `1..2` and a
 * daemon at v1, the handshake negotiates 1 and every stream then said 2, so the
 * daemon refused every request with 501 while the tunnel stayed up and the
 * machine drew as online. That is worse than the 426 flag day the range replaced.
 *
 * Asserted against a version this build does **not** speak, so it stays a real
 * comparison whatever `RELAY_PROTOCOL_VERSION` becomes — the exact mistake being
 * corrected was an assertion that could only ever compare a constant to itself.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a stream is stamped with\n");
{
  // Typed `number` rather than left as the literal `7`: tsc narrows a literal and
  // then calls the comparison below unintentional, which is it proving the point
  // at build time and refusing to let the driver make it at run time.
  const NEGOTIATED: number = 7;
  const seen: Array<string | undefined> = [];

  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const clientSide = Duplex.from({ readable: toClient, writable: toServer });
  const serverSide = Duplex.from({ readable: toServer, writable: toClient });

  const server = createH2Server();
  server.on("stream", (stream, headers) => {
    seen.push(headers[STREAM_VERSION_HEADER] as string | undefined);
    stream.respond({ ":status": 200 });
    stream.end();
  });
  server.emit("connection", serverSide);

  const session = h2connect("http://tunnel", { createConnection: () => clientSide });
  session.on("error", () => {});

  const held = new EndpointTunnel("m_stamp", Date.now(), NEGOTIATED, session, () => session.destroy());
  const stream = held.open("u_someone");
  // Awaited on the stream's own response rather than on a sleep: an unref'd timer
  // lets the process exit before the assertion runs, which node reports as an
  // unsettled top-level await and which would otherwise be a check that never ran.
  await new Promise<void>((resolve) => {
    if (stream === null) return resolve();
    stream.on("response", () => resolve());
    stream.on("error", () => resolve());
  });

  check("a stream carries the version its tunnel negotiated", seen, [String(NEGOTIATED)]);
  report(
    "which is not this build's maximum, so the comparison is a real one",
    NEGOTIATED !== RELAY_PROTOCOL_VERSION,
    `negotiated ${NEGOTIATED}, this build speaks ${RELAY_PROTOCOL_VERSION}`,
  );

  held.close(1000, "done");
  server.close();
}


/* ------------------------------------------------------------------ *
 * The relay's own health route
 *
 * One route, and its whole correctness is the path it did **not** take.
 *
 * `/health` through the relay belongs to the *daemon*: it is what a browser
 * fetches, with a token, to settle a machine's route. A relay that answered it
 * would report every machine in the fleet as reachable — including ones holding
 * no tunnel at all — and every deploy probe would go green against a relay
 * carrying nothing. So the two are asserted together, because it is the pair
 * that means anything.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe relay's own health\n");
{
  const bare = await fetch(`${relayUrl}${RELAY_HEALTH_PATH}`);
  check("the relay answers for itself with no credential at all", bare.status, 200);
  const body = (await bare.json()) as Record<string, unknown>;
  check("and says which service it is, so a probe cannot be fooled by a daemon", body, {
    ok: true,
    service: "relay",
    database: "ok",
  });

  /*
   * **`database` is the half that can go red, and it had no way to.** This route
   * answered a literal, so a relay that could not read `signing_keys` — a full
   * disk, a volume gone read-only, a file that would not open — verified no token
   * and refused the whole fleet with 401 while reporting itself healthy, and
   * compose's healthcheck stayed green over it.
   *
   * Asserted as the *field* rather than by breaking the database, because the one
   * this driver holds is shared by every section after this one.
   */
  report("with a field that can say otherwise", typeof body["database"] === "string", `database: ${String(body["database"])}`);

  /*
   * And the property that must survive it: there is no credential on this path,
   * so it may say the listener is up and must not say who is on it. A tunnel
   * count here would be an unauthenticated read of how much of the fleet is
   * online — asserted by name, because "add the number of tunnels" is the
   * obvious next thing to reach for.
   */
  report(
    "and still nothing about who is connected",
    Object.keys(body).sort().join(",") === "database,ok,service",
    `keys: ${Object.keys(body).sort().join(",")}`,
  );

  const before = proxied(mine);
  check("while /health is still proxied, and still needs a token", (await relayFetch("/health", null)).status, 401);
  check("and reaches the daemon with one", (await relayFetch("/health", tokenFor(alice, mine))).status, 200);
  report("so the daemon's own health is what a client measures", proxied(mine) - before === 1, `${proxied(mine) - before} streams`);

  // The reserved prefix is the relay's, but only at the two paths it claims.
  check("a neighbouring path under the same prefix is not the relay's", (await relayFetch("/__relay/other", null)).status, 401);
}

/* ------------------------------------------------------------------ *
 * Presence: the only part of a tunnel that can be written down
 *
 * With the relay in its own container, `app.ts` has no `TunnelRegistry` to ask —
 * so `relayOnline` on `POST /v1/tokens` and `GET /v1/admin/relay` read a table
 * the relay writes instead. What is asserted here is the lifecycle, because two
 * of its rules are ones the in-memory registry learned the hard way and the row
 * would otherwise have to learn again.
 * ------------------------------------------------------------------ */

process.stdout.write("\ntunnel presence, as a row\n");
{
  let clock = 1_000_000;
  const presence = createPresenceWriter(db, { relayId: DEFAULT_RELAY_ID, now: () => clock });
  const view = dbRelayView(db, { now: () => clock });
  const rows = (): unknown[] => db.prepare("SELECT machine_id, relay_id, connected_at, last_seen_at FROM relay_tunnels ORDER BY machine_id").all();

  presence.clear();
  check("a relay clears its own rows at boot, because it cannot have any yet", rows(), []);

  /*
   * **When a machine was last seen, which survives the tunnel row.**
   *
   * `relay_tunnels` is deleted on disconnect — that is what makes it presence —
   * so "offline for a minute" and "offline for a week" were one answer
   * everywhere: a boolean with nothing behind it. A closed laptop and a VPS that
   * died on Tuesday drew identically, there was no way to alert on "offline >
   * 24h", and the first question anybody asks about a machine that is not
   * answering had no answer at all.
   */
  const lastSeen = (machineId: string): number | null => {
    const row = db.prepare("SELECT at FROM machine_last_seen WHERE machine_id = ?").get(machineId);
    return row === undefined ? null : Number(row["at"]);
  };
  check("nothing is recorded for a machine that has never dialled in", lastSeen("m_one"), null);

  presence.up("m_one", clock - 5_000);
  check("registering writes one row carrying when the tunnel connected", view.stats(), [
    { machineId: "m_one", relayId: DEFAULT_RELAY_ID, since: clock - 5_000, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("and the API's question is answered from it", [view.isOnline("m_one"), view.isOnline("m_two")], [true, false]);

  /*
   * **Newest wins, as one row.** The registry's `register` overwrites its map
   * entry rather than keeping two, and a second row here would make one machine
   * appear twice in `GET /v1/admin/relay` with no way to tell which socket is
   * live.
   */
  presence.up("m_one", clock - 1_000);
  check("a supersede overwrites rather than duplicating", rows().length, 1);
  check("and the row is the newer tunnel's", view.stats()[0]?.since, clock - 1_000);

  check("and dialling in is recorded where the tunnel row cannot reach", lastSeen("m_one"), clock);

  presence.down("m_one");
  check("unregistering removes it", [rows(), view.isOnline("m_one")], [[], false]);
  /*
   * **And this is the half that has to survive it.** The presence row is gone —
   * correctly, the machine is not there — and the record of *when it was* is
   * what turns "offline" from a boolean into an answer.
   */
  check("but when it was last there survives the disconnect", lastSeen("m_one"), clock);

  /*
   * The flush, which is what makes every write above an optimisation rather than
   * a requirement. Everything live is stamped with one `at`; anything this relay
   * owns that was not stamped is older and swept — so a lost `up` is repaired
   * within one tick and a lost `down` costs one tick rather than a whole
   * staleness window.
   */
  presence.flush([
    { machineId: "m_one", relayId: DEFAULT_RELAY_ID, since: clock - 1_000, activeStreams: 2, requestsProxied: 7 },
    { machineId: "m_two", relayId: DEFAULT_RELAY_ID, since: clock, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("a flush writes what is live, counters and all", view.stats(), [
    { machineId: "m_one", relayId: DEFAULT_RELAY_ID, since: clock - 1_000, activeStreams: 2, requestsProxied: 7 },
    { machineId: "m_two", relayId: DEFAULT_RELAY_ID, since: clock, activeStreams: 0, requestsProxied: 0 },
  ]);

  clock += 1_000;
  presence.flush([{ machineId: "m_two", relayId: DEFAULT_RELAY_ID, since: clock - 1_000, activeStreams: 0, requestsProxied: 1 }]);
  check("and sweeps what this relay no longer holds, with no list of ids", view.stats().map((row) => row.machineId), ["m_two"]);

  /*
   * **Staleness, and which way it is allowed to be wrong.** A relay killed hard
   * cannot delete its rows, so a reader has to decide how long to believe one. A
   * stale `true` costs a probe and a `503 no_tunnel`, which every client already
   * turns into "forget the route"; a stale `false` draws a reachable machine as
   * offline and nothing probes it again.
   */
  clock += PRESENCE_STALE_MS;
  check("a row exactly at the window is still believed", view.isOnline("m_two"), true);
  clock += 1;
  check("and one past it is not, for either reader", [view.isOnline("m_two"), view.stats()], [false, []]);
  check("though the row is still there to be swept by whoever replaces this relay", rows().length, 1);

  /*
   * Another relay's rows are not this one's to clear. One relay is the whole of
   * today's deployment, so this is about the id being a *slot* — the row a dead
   * relay left behind is cleared by its replacement under the same name, and by
   * nobody else.
   */
  const other = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
  other.up("m_three", clock);
  presence.clear();
  check("clearing takes only the rows this relay id owns", rows().length, 1);
  check("and that survivor is the other relay's", view.stats().map((row) => row.machineId), ["m_three"]);

  /*
   * **Which relay holds it — the question a second relay makes answerable.**
   *
   * `relay_id` has been a column since the split, written by whoever holds the
   * tunnel and read by nobody: `isOnline` asked "is there a row" and threw the
   * name away. That is exactly enough while one relay exists and exactly not
   * enough the moment two do, because a `TunnelRegistry` is in-memory per
   * process — a browser that lands on the wrong relay gets `503 no_tunnel`.
   *
   * Asserted here, against a row written by a relay this reader is not,
   * because that is the whole case: `dbRelayView` can name a relay it has never
   * spoken to, and a `TunnelRegistry` structurally cannot.
   */
  check("a reader can name the relay holding a machine", view.relayFor("m_three"), "relay-2");
  check("and answers nothing for a machine with no tunnel", view.relayFor("m_nobody"), null);
  /*
   * The same staleness window as `isOnline`, and it has to be: a row this view
   * calls absent must not still name somewhere to dial. Two readers of one table
   * disagreeing about whether a row counts is the shape nobody would look for.
   */
  clock += PRESENCE_STALE_MS + 1;
  check("a row past the window names nobody either", [view.isOnline("m_three"), view.relayFor("m_three")], [false, null]);
  clock -= PRESENCE_STALE_MS + 1;

  other.clear();
  check("which its own owner can then take", rows(), []);

  /*
   * **Through the registry, which is where the two rules meet.**
   *
   * The section above drives the writer directly; this drives the object that
   * calls it, because the row inherits its correctness from the map's own
   * identity check rather than from anything in `presence.ts`. The supersede
   * case is the one that matters: the displaced tunnel's close lands *after* its
   * replacement registered, so a `down` above the guard would delete the row of
   * the tunnel that is actually up — and the API would then draw a live machine
   * as offline, which is the one direction of staleness nothing corrects.
   */
  const mirrored = new TunnelRegistry(() => {}, presence);
  const parked = (): ClientHttp2Session => h2connect("http://tunnel", { createConnection: () => new PassThrough() });
  const sessionA = parked();
  const sessionB = parked();
  const first = new EndpointTunnel("m_mirror", clock - 10, RELAY_PROTOCOL_VERSION, sessionA, () => sessionA.destroy());
  const second = new EndpointTunnel("m_mirror", clock, RELAY_PROTOCOL_VERSION, sessionB, () => sessionB.destroy());

  mirrored.register(first, CLOSE_TUNNEL_SUPERSEDED);
  check("registering a tunnel writes its presence", view.isOnline("m_mirror"), true);

  mirrored.register(second, CLOSE_TUNNEL_SUPERSEDED);
  mirrored.unregister(first);
  check("and a superseded tunnel's late close does not delete the replacement's row", view.isOnline("m_mirror"), true);
  check("which is still one row, carrying the newer tunnel", view.stats(), [
    { machineId: "m_mirror", relayId: DEFAULT_RELAY_ID, since: clock, activeStreams: 0, requestsProxied: 0 },
  ]);

  /*
   * `closeAll` clears the map, which makes every later `unregister` a no-op — so
   * the row has to be deleted by that call itself or a planned shutdown leaves
   * the fleet claimed for a whole staleness window.
   */
  mirrored.closeAll(CLOSE_TUNNEL_SUPERSEDED, "relay shutting down");
  check("and stopping the relay takes its rows with it", [view.isOnline("m_mirror"), rows()], [false, []]);
  sessionA.destroy();
  sessionB.destroy();

  /*
   * A registry names itself and never another relay.
   *
   * The honest answers for one process are "me" and "I do not have it" — it
   * deliberately does not fall back to the table, because a relay answering on
   * another relay's behalf would route a browser on the strength of a row it
   * does not maintain.
   */
  /*
   * **The slot is claimed, and a second live process is refused.**
   *
   * Two relays under one `REEMOAT_CP_RELAY_ID` delete each other's rows every
   * five seconds — `sweep` removes rows carrying this name that this relay's own
   * flush did not stamp, which is every machine on the other one. It was
   * documented and enforced by nothing, which is the shape this repository
   * refuses; `claimDaemonLock` is the precedent one package over.
   *
   * The liveness signal is a heartbeat rather than a pid, because a relay runs
   * in a container and `pid`/`os.uptime()` mean nothing across namespaces.
   */
  {
    const claimClock = { at: 5_000_000 };
    const first = claimRelayId(db, "relay-slot", "nonce-a", claimClock.at);
    check("the first relay takes the slot", first.ok, true);
    const second = claimRelayId(db, "relay-slot", "nonce-b", claimClock.at + 1_000);
    check("a second live process is refused, not merely warned", second.ok, false);
    check(
      "and is told how long ago the holder was seen, so a stale claim reads differently",
      !second.ok && second.lastSeenMsAgo,
      1_000,
    );
    /*
     * Re-claiming under the *same* nonce is a restart of the same process, not a
     * collision — otherwise a relay could never re-enter its own claim.
     */
    check("the holder can re-claim its own slot", claimRelayId(db, "relay-slot", "nonce-a", claimClock.at + 2_000).ok, true);
    // The re-claim refreshed `last_seen_at`, so the window runs from *there* —
    // which is the point of a heartbeat and is worth stepping from explicitly
    // rather than from the original claim.
    const afterReclaim = claimClock.at + 2_000;
    /*
     * Taking over a stale claim is the normal path rather than an edge case: a
     * relay killed hard leaves this row exactly as it leaves its tunnel rows.
     * Refusing for ever would make a crash cost a manual repair on the fleet's
     * only entrance.
     */
    check(
      "a claim past the window is taken over",
      claimRelayId(db, "relay-slot", "nonce-c", afterReclaim + RELAY_CLAIM_STALE_MS + 1).ok,
      true,
    );
    /*
     * And releasing is identity-checked, for `unregister`'s reason: without it a
     * relay refused at boot would clear the *live* relay's claim on its way to
     * exiting — turning the refusal that protects the fleet into the collision
     * it exists to prevent.
     */
    releaseRelayId(db, "relay-slot", "nonce-a");
    check("a process that lost the slot cannot release it", claimRelayId(db, "relay-slot", "nonce-d", afterReclaim + RELAY_CLAIM_STALE_MS + 2).ok, false);
    releaseRelayId(db, "relay-slot", "nonce-c");
    check("while its real holder can, so a planned stop costs no window", claimRelayId(db, "relay-slot", "nonce-e", afterReclaim + RELAY_CLAIM_STALE_MS + 3).ok, true);
    releaseRelayId(db, "relay-slot", "nonce-e");
  }

  const named = new TunnelRegistry(() => {}, null, "relay-7");
  const sessionC = parked();
  const held = new EndpointTunnel("m_named", clock, RELAY_PROTOCOL_VERSION, sessionC, () => sessionC.destroy());
  named.register(held, CLOSE_TUNNEL_SUPERSEDED);
  check("a registry names itself for a tunnel it holds", named.relayFor("m_named"), "relay-7");
  check("and nothing for one it does not", named.relayFor("m_elsewhere"), null);
  named.closeAll(CLOSE_TUNNEL_SUPERSEDED, "done");
  sessionC.destroy();
}

/* ------------------------------------------------------------------ *
 * Which relay a browser is sent to
 *
 * `relay_id` has been a column since the split and was read by nothing:
 * `isOnline` asked "is there a row" and threw the name away, which is exactly
 * enough for one relay and exactly not enough for two. A `TunnelRegistry` is
 * in-memory per process, so a request that lands on relay B for a machine held
 * by relay A answers `503 no_tunnel` — with every relay behind one name that is
 * a one-in-N coin flip per request.
 *
 * These drive the route a browser actually reads, `POST /v1/tokens`, because the
 * pure half above would pass with `app.ts` ignoring the answer.
 * ------------------------------------------------------------------ */

process.stdout.write("\nrouting a browser to the relay that holds the machine\n");
{
  /*
   * The parser first, because it is the only new *parsing* in the change and
   * because `main.ts` cannot be imported by anything — it starts a listener and
   * mints a bootstrap admin at module scope. That is why these two live in
   * `relay/routing.ts` rather than beside their one caller.
   *
   * The scheme rule is the one worth driving. `new URL` accepts far more than a
   * browser does: measured, `r2.example:7889` parses with protocol
   * `r2.example:`, and `install.sh` writes `http://host:port` one variable over,
   * which makes a bare `host:port` the natural typo. And `wss://` — the value
   * that *looks* right — is worse than a refusal: `machine.ts` probes a route
   * with `fetch`, which rejects it outright, and `streamUrl` turns anything that
   * is not `https:` into a **plaintext** `ws:` socket carrying `?token=`.
   */
  check("http and https are what a browser can be handed", [
    isBrowserReachable("https://r1.example"),
    isBrowserReachable("http://127.0.0.1:7889"),
  ], [true, true]);
  check("wss is refused, though it is the one that looks right", isBrowserReachable("wss://r1.example"), false);
  check("and so is a bare host:port, which `new URL` happily parses", isBrowserReachable("r2.example:7889"), false);

  check("an absent map is the single-relay shape", parseRelayUrls(undefined), null);
  check("a well-formed pair parses", parseRelayUrls("relay-1=https://r1.example"), { "relay-1": "https://r1.example" });
  check("as do several, with whitespace", parseRelayUrls(" relay-1=https://r1.example , relay-2=https://r2.example "), {
    "relay-1": "https://r1.example",
    "relay-2": "https://r2.example",
  });
  // The value may carry its own `=`; only the first one separates.
  check("a query string in the value survives", parseRelayUrls("r=https://x.example/?a=b"), { r: "https://x.example/?a=b" });
  check("an entry with no separator is refused", parseRelayUrls("relay-1"), "invalid");
  check("so is an empty id", parseRelayUrls("=https://r1.example"), "invalid");
  /*
   * Refused rather than last-wins: two entries for one slot is a copy-paste, and
   * silently keeping the second sends every browser for that relay to the wrong
   * host with nothing said anywhere.
   */
  check("a duplicate id is refused rather than resolved", parseRelayUrls("r=https://a.example,r=https://b.example"), "invalid");
  check("a value the browser cannot dial is refused", parseRelayUrls("r=wss://a.example"), "invalid");
  // Nothing but separators parsed to an empty map, which would read as "one
  // relay" while the operator clearly meant several.
  check("and a value that is nothing but commas is not an empty fleet", parseRelayUrls(",,"), "invalid");
  /*
   * `Object.create(null)`, so a relay named `toString` is a legal slot rather
   * than a duplicate — and, on the way out, cannot resolve to an inherited
   * function that `c.json` would drop, leaving one machine in the fleet with no
   * `relayUrl` field at all.
   */
  check("a slot named after a prototype member is ordinary", parseRelayUrls("toString=https://t.example"), { toString: "https://t.example" });

  const clock = 2_000_000;
  const presence = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
  const view = dbRelayView(db, { now: () => clock });

  const key = newApiKey();
  const adminKey = newApiKey();
  const userId = newId("u");
  const adminId = newId("u");
  const machineId = newId("m");
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(userId, "router", clock);
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 1, ?)").run(adminId, "routeadmin", clock);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    newId("ak"), adminId, adminKey.prefix, adminKey.hash, clock,
  );
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    newId("ak"), userId, key.prefix, key.hash, clock,
  );
  db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
    machineId, "routed-box", clock, clock,
  );
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
    userId, machineId, "session:read session:write", clock,
  );

  const DEFAULT_URL = "https://relay.example";
  const routed = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl: DEFAULT_URL,
    relayUrls: { "relay-2": "https://r2.example", "relay-3": "https://r3.example" },
    relay: view,
  });
  const mint = async (): Promise<string | null> => {
    const answer = await routed.request("/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: machineId }),
    });
    if (answer.status !== 200) return `status ${answer.status}`;
    return ((await answer.json()) as { machine: { relayUrl: string | null } }).machine.relayUrl;
  };

  /*
   * No tunnel: the default, and it rides beside `relayOnline: false` which is
   * what the client acts on. A `null` here would be a field no client is typed
   * for, on the route that decides whether the machine is reachable at all.
   */
  check("a machine with no tunnel gets the shared name", await mint(), DEFAULT_URL);

  presence.up(machineId, clock);
  check("and one held by a relay gets that relay's own", await mint(), "https://r2.example");

  /*
   * A slot with no entry in the map — an operator added a relay and forgot its
   * URL. The shared name is the same coin flip it had before rather than a
   * `null`, so the failure is "sometimes slow" and not "the field is missing".
   */
  const stray = createPresenceWriter(db, { relayId: "relay-9", now: () => clock });
  stray.up(machineId, clock);
  check("a relay the map does not name falls back rather than answering nothing", await mint(), DEFAULT_URL);

  /*
   * And with no map at all — the single-relay shape, which is every deployment
   * until somebody splits. The row still says `relay-9`; nothing consults it.
   */
  const single = createControlPlaneApp({
    db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl: DEFAULT_URL, relay: view,
  });
  const fromSingle = await single.request("/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
    body: JSON.stringify({ machine: machineId }),
  });
  check(
    "an unconfigured fleet keeps answering with the one URL it has",
    ((await fromSingle.json()) as { machine: { relayUrl: string | null } }).machine.relayUrl,
    DEFAULT_URL,
  );

  /*
   * **The other call site, and it is the dominant one.** `relayUrlFor` is used
   * twice: `POST /v1/tokens` above, and `GET /v1/machines` — which
   * `MachineConnection.update` reads on every four-second poll and writes
   * straight over `this.relayUrl`. So a regression there is not "a stale value
   * until the next mint", it is the client being clobbered back to the shared
   * name continuously, while a token minted minutes ago stays fresh and nothing
   * re-mints. Without this case, reverting that call site leaves the driver
   * green.
   */
  presence.clear();
  stray.clear();
  presence.up(machineId, clock);
  const listed = await routed.request("/v1/machines", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  check(
    "the machines listing routes per machine too, not just the token route",
    ((await listed.json()) as { machines: { id: string; relayUrl: string | null }[] }).machines.find(
      (m) => m.id === machineId,
    )?.relayUrl,
    "https://r2.example",
  );

  /*
   * **A stale relay must not steal the row back.** A tunnel stays in a relay's
   * map until its ping tick notices the socket is gone — up to 40 s — and
   * `stats()` iterates that map directly, so relay A goes on flushing a machine
   * that has already redialled onto relay B. With the flush's upsert re-stamping
   * `relay_id` unconditionally, as it did, A reclaimed the row every five
   * seconds and `relayFor` named the relay holding the corpse.
   *
   * The rule is `connected_at`: a genuine redial is strictly newer, so ownership
   * still transfers when it should, and a stale relay carrying the old `since`
   * loses.
   */
  const relayA = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
  const relayB = createPresenceWriter(db, { relayId: "relay-3", now: () => clock });
  relayB.up(machineId, clock + 5_000); // the redial, strictly newer
  check("a redial moves the row to the relay that took it", view.relayFor(machineId), "relay-3");
  relayA.flush([
    { machineId, relayId: "relay-2", since: clock, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("and the relay it left cannot take it back on a heartbeat", view.relayFor(machineId), "relay-3");
  /*
   * The half that keeps the flush a repair rather than only a restriction: a
   * relay whose `up` write was lost still claims the row, because its tunnel is
   * the newer one. Asserting only the refusal above would pass against a flush
   * that had simply stopped writing.
   */
  relayA.flush([
    { machineId, relayId: "relay-2", since: clock + 9_000, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("while a newer tunnel still claims it through the flush", view.relayFor(machineId), "relay-2");

  relayA.clear();
  relayB.clear();

  /*
   * **A relay id nobody mapped, made visible.**
   *
   * The map is keyed on a name the relay chooses and nothing cross-checks the
   * two, so a missing entry degrades to the shared URL and keeps working — one
   * request in N slowly, with no error anywhere. That is this feature's own
   * stated failure mode, and until `unmapped` it was undetectable short of
   * opening the database.
   */
  {
    const stranger = createPresenceWriter(db, { relayId: "relay-unlisted", now: () => clock });
    stranger.up(machineId, clock);
    const seen = (await (
      await routed.request("/v1/admin/relay", { headers: { authorization: `Bearer ${adminKey.key}` } })
    ).json()) as { unmapped: string[]; tunnels: { relayId: string }[] };
    check("a relay holding tunnels with no entry in the map is named", seen.unmapped, ["relay-unlisted"]);
    check("and the listing says which relay each tunnel is on", seen.tunnels.map((t) => t.relayId), ["relay-unlisted"]);

    /*
     * Empty where there is no map, deliberately: that is the single-relay shape,
     * and falling back to the one URL there is not a fallback but the answer.
     * Without this arm every existing deployment would warn about itself.
     */
    const plain = (await (
      await single.request("/v1/admin/relay", { headers: { authorization: `Bearer ${adminKey.key}` } })
    ).json()) as { unmapped: string[] };
    check("while an unconfigured fleet warns about nothing", plain.unmapped, []);
    stranger.clear();
  }

  presence.clear();

  /*
   * **Two relays, two machines, at the same time — which nothing above asserts.**
   *
   * Every routing case in this section operates on one `machineId`, and
   * `relay_tunnels.machine_id` is the conflict target of the upsert, so only one
   * row has ever existed while they ran: the relay ids take turns over a single
   * machine. That covers "the column is read" and leaves the actual feature —
   * *this* browser to relay A while *that* browser goes to relay B, out of one
   * listing, in one request — resting on the same lookup being right twice.
   *
   * It is the shape a per-machine answer regresses to most naturally, too: any
   * change that resolves the URL once per *request* rather than once per *row*
   * passes every case above and fails only here.
   */
  {
    const second = newId("m");
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
      second, "routed-box-2", clock, clock,
    );
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      userId, second, "session:read session:write", clock,
    );

    const onTwo = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
    const onThree = createPresenceWriter(db, { relayId: "relay-3", now: () => clock });
    onTwo.up(machineId, clock);
    onThree.up(second, clock);

    const rows = ((await (
      await routed.request("/v1/machines", { headers: { authorization: `Bearer ${key.key}` } })
    ).json()) as { machines: { id: string; relayUrl: string | null; relayOnline: boolean }[] }).machines;
    const urlOf = (id: string): string | null => rows.find((row) => row.id === id)?.relayUrl ?? null;

    check(
      "one listing sends two machines to two different relays",
      [urlOf(machineId), urlOf(second)],
      ["https://r2.example", "https://r3.example"],
    );
    check(
      "and both read as online, since presence is per row rather than per process",
      rows.filter((row) => row.relayOnline).length,
      2,
    );

    /*
     * And the token route agrees with the listing, per machine. These are the two
     * call sites of `relayUrlFor` and the client writes whichever answered last
     * over the same field — so a disagreement between them is a machine that
     * flips relay every four seconds.
     */
    const mintFor = async (id: string): Promise<string | null> => {
      const answer = await routed.request("/v1/tokens", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
        body: JSON.stringify({ machine: id }),
      });
      return ((await answer.json()) as { machine: { relayUrl: string | null } }).machine.relayUrl;
    };
    check("the token route agrees with the listing, per machine", [await mintFor(machineId), await mintFor(second)], [
      "https://r2.example",
      "https://r3.example",
    ]);

    onTwo.clear();
    onThree.clear();
  }

  /*
   * **The heartbeat that keeps a relay's claim on its own slot alive.**
   *
   * `claimRelayId` refuses a name a live process holds, and what makes a process
   * "live" is `relay_instances.last_seen_at` being re-stamped — by `flush`, on
   * the same transaction it uses for the tunnel rows. That is the only thing
   * standing between a second relay started under the same id and the failure
   * `RELAY_CLAIM_STALE_MS` exists to prevent: two relays under one name sweep
   * each other's rows every five seconds and the fleet flaps with nothing saying
   * why.
   *
   * It was asserted nowhere. Every `createPresenceWriter` in this driver omits
   * `nonce`, which defaults to `""`, so `beat` updated zero rows in all of them —
   * the claim tests drive `claimRelayId` directly with hand-rolled clocks, and
   * the *keeping* half had no coverage at all. A flush that stopped stamping
   * would have left every case in this file green.
   */
  {
    // Slot names of its own, because `relay_instances` is keyed on the id and the
    // sections around this one hold their own.
    let at = 5_000_000;
    check("a relay takes its slot", claimRelayId(db, "beat-idle", "nonce-a", at).ok, true);

    // Long enough that the claim is stale on its own, which is the state a second
    // relay is allowed to take over in — and the baseline the case below is
    // measured against.
    at += RELAY_CLAIM_STALE_MS + 1_000;
    check("and goes stale if nothing keeps it", claimRelayId(db, "beat-idle", "nonce-b", at).ok, true);

    /*
     * Now the same window, with a flush inside it — and **no tunnels**, because a
     * relay holding none still owns its name. That is precisely why `beat` sits
     * outside the loop over rows rather than inside it, and an empty list is the
     * arrangement that would catch it having drifted in.
     */
    const holder = createPresenceWriter(db, { relayId: "beat-live", nonce: "nonce-c", now: () => at });
    check("another takes a different slot", claimRelayId(db, "beat-live", "nonce-c", at).ok, true);
    at += RELAY_CLAIM_STALE_MS - 1_000;
    holder.flush([]);
    at += 2_000; // past the window, had the flush not stamped it
    const contested = claimRelayId(db, "beat-live", "nonce-d", at);
    report(
      "but a relay that is still flushing keeps it",
      !contested.ok,
      contested.ok ? "the claim was handed over" : `held by ${contested.heldBy}, last seen ${contested.lastSeenMsAgo}ms ago`,
    );

    /*
     * And the identity check on the stamp itself: a relay whose claim was taken
     * over while it was paused must not silently take it back on its next
     * heartbeat. It keeps serving what it holds and its rows go stale, which is
     * the same answer `refresh` gives one statement up.
     */
    at += RELAY_CLAIM_STALE_MS + 1_000;
    check("a lost claim can be taken", claimRelayId(db, "beat-live", "nonce-e", at).ok, true);
    at += 1_000;
    holder.flush([]);
    const stolen = claimRelayId(db, "beat-live", "nonce-f", at + 1_000);
    report(
      "and the relay that lost it cannot stamp its way back",
      !stolen.ok && stolen.heldBy === "nonce-e",
      stolen.ok ? "the claim was free" : `held by ${stolen.heldBy}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * The control plane's own HTTP surface
 *
 * `createControlPlaneApp` returns a Hono app, and `app.request()` drives it
 * offline against the in-memory database this file already builds — no listener,
 * no sockets. Until now the entire `/v1` surface was reachable only by starting
 * the real server, so none of it had any coverage at all, including the routes
 * that decide a machine's routing policy and the single-use rule that stops two
 * daemons claiming one identity.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe control plane's routes\n");
{
  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
  });

  const adminKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_admin', 'admin', 1, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_admin', ?, ?, ?)").run(
    newId("ak"),
    adminKey.prefix,
    adminKey.hash,
    now,
  );
  const admin = { authorization: `Bearer ${adminKey.key}`, "content-type": "application/json" };

  // `app.request` is typed `Response | Promise<Response>`; awaiting through
  // `Promise.resolve` keeps every call site a plain `await`.
  const patch = async (id: string, body: unknown): Promise<Response> =>
    Promise.resolve(
      app.request(`/v1/admin/machines/${id}`, { method: "PATCH", headers: admin, body: JSON.stringify(body) }),
    );
  const nameOf = async (response: Response): Promise<unknown> =>
    ((await response.json()) as { name: unknown }).name;

  check("an unauthenticated admin route is refused", (await app.request("/v1/admin/machines")).status, 401);

  /*
   * This route used to carry `baseUrl` as well, which between `--url` and
   * `--no-url` was the whole routing policy for a machine. There is no such
   * choice now — every user reaches every machine through this service — so what
   * is left to assert is that renaming still works and still cannot collide.
   *
   * A machine has **no address at all** in the registry, and that is the property
   * worth pinning down here rather than in prose.
   */
  check("a machine can be renamed", await nameOf(await patch(mine, { name: "renamed" })), "renamed");
  // Back to its original name, which is its id here: later sections resolve a
  // machine by either, and leaving it renamed would make them pass for a reason
  // nobody meant.
  check("and renamed back", await nameOf(await patch(mine, { name: mine })), mine);
  check("an absent field changes nothing", await nameOf(await patch(mine, {})), mine);
  check("a name clash is a 409", (await patch(mine, { name: other })).status, 409);
  check("an unknown machine is a 404", (await patch("m_nope", { name: "x" })).status, 404);
  check(
    "and no machine route reports an address",
    Object.keys((await (await patch(mine, {})).json()) as Record<string, unknown>).includes("baseUrl"),
    false,
  );

  // Every machine route describes the same entity, so they have to agree about
  // which fields that entity has.
  const listed = (await (await app.request("/v1/admin/machines", { headers: admin })).json()) as {
    machines: Record<string, unknown>[];
  };
  const patched = (await (await patch(mine, {})).json()) as Record<string, unknown>;
  report(
    "PATCH and GET describe a machine the same way",
    JSON.stringify(Object.keys(patched).sort()) === JSON.stringify(Object.keys(listed.machines[0] ?? {}).sort()),
    Object.keys(patched).sort().join(","),
  );

  /*
   * Single use, enforced by one conditional UPDATE.
   *
   * Two redemptions fired together: exactly one may win. Reading the row and then
   * marking it used would let both through, which is precisely what a single-use
   * code must not allow — and it is the difference between two daemons sharing one
   * machine identity and not.
   */
  /*
   * A machine of its own, deliberately not `m_mine`.
   *
   * Redeeming an enrollment code issues a fresh tunnel credential and retires the
   * previous one — that is the point of it — so redeeming against the machine
   * whose live tunnel later sections depend on revokes the key underneath them.
   * Found by doing exactly that: `losing the tunnel` then failed to reconnect.
   */
  const enrollee = addMachine("m_enroll");
  const minted = (await (
    await app.request(`/v1/admin/machines/${enrollee}/enrollments`, { method: "POST", headers: admin })
  ).json()) as { code: string };
  const redeem = async (): Promise<Response> =>
    Promise.resolve(
      app.request("/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: minted.code }),
      }),
    );
  const both = await Promise.all([redeem(), redeem()]);
  check(
    "exactly one of two concurrent redemptions wins",
    both.map((r) => r.status).sort().join(","),
    "200,409",
  );
  check("and a third is refused too", (await redeem()).status, 409);

  // `/v1/jwks` publishes public keys and is deliberately unauthenticated.
  const jwks = (await (await app.request("/v1/jwks")).json()) as { keys: { kid: string; jwk: unknown }[] };
  report("jwks publishes the active key", jwks.keys.some((k) => k.kid === signing.kid), `${jwks.keys.length} key(s)`);
  report(
    "and no private material with it",
    !JSON.stringify(jwks).includes("PRIVATE"),
    "no PEM in the response",
  );

  // Grants are users × machines, so the listing is paged and says so.
  const grants = (await (await app.request("/v1/admin/grants?limit=1", { headers: admin })).json()) as {
    grants: unknown[];
    total: number;
    limit: number;
  };
  check("the grant listing honours a limit", grants.grants.length, 1);
  report("and reports the true total", grants.total >= 2, `total ${grants.total}`);
}

/* ------------------------------------------------------------------ *
 * Signing in, sessions, passwords and machines somebody owns
 *
 * Same technique as the section above — `createControlPlaneApp` driven through
 * `app.request()` against the in-memory database, no listener and no sockets —
 * for the surface that decides who anybody is.
 *
 * **This section is slower than the rest of this file put together**, by design:
 * roughly forty scrypt operations at ~50ms each. That is the KDF doing its job,
 * it is stated here so the next person does not go looking for a hang, and the
 * last check in the block fails if somebody raises the parameters far enough to
 * turn a login into a timeout.
 *
 * Fresh users and fresh machines throughout. `m_mine` is left alone for the reason
 * the enrollment case above already gives: redeeming a code retires a machine's
 * tunnel key, and this file's earlier sections are still using that one.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsigning in, sessions and passwords\n");
{
  /*
   * **Built as a *proxied* instance, and that is what makes the address cases in
   * this block mean anything.**
   *
   * `app.request()` opens no socket, so every caller here is one address unless
   * `x-forwarded-for` is believed — and the default is now to ignore it, because
   * a header nobody vouched for is a rate-limit key the caller writes. One
   * trusted hop is the shape `install.sh` recommends (publish on loopback, TLS
   * proxy in front), so setting it here lets the driver stand in for that proxy
   * and drive the two properties that need distinct addresses: what a session
   * records about itself, and that a spray aimed at one person cannot lock them
   * out of their own sign-in.
   *
   * The *unproxied* default is asserted separately, below, where the property is
   * that a forged header moves nothing at all.
   */
  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
    trustedProxyHops: 1,
  });

  const adminKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_root', 'root', 1, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_root', ?, ?, ?)").run(
    newId("ak"),
    adminKey.prefix,
    adminKey.hash,
    now,
  );
  const admin = { authorization: `Bearer ${adminKey.key}`, "content-type": "application/json" };
  const bearer = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  const send = async (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(app.request(path, init));
  const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
    send(path, { method: "POST", headers, body: JSON.stringify(body) });
  /** `[status, code]` — the pair almost every assertion here is about. */
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];
  const login = (name: string, password: string): Promise<Response> =>
    post("/v1/login", { name, password }, { "content-type": "application/json" });

  /* -- the gate ------------------------------------------------------ */

  check("an unauthenticated /v1/me/password is refused", (await send("/v1/me/password", { method: "POST" })).status, 401);
  check(
    "so is minting an enrollment code for a machine",
    (await send("/v1/machines/m_x/enrollments", { method: "POST" })).status,
    401,
  );
  check("so is signing out", (await send("/v1/me/sessions/current", { method: "DELETE" })).status, 401);
  check("so is creating a machine", (await send("/v1/machines", { method: "POST" })).status, 401);
  /*
   * The three that must stay public, and they are public because of where they sit
   * in the file rather than because of a list. A route added below the gate is
   * refused by doing nothing, which is the opposite of the four exact-path
   * `app.use` lines this replaced.
   */
  /*
   * ⚠ **What the daemon is told to dial, behind a TLS proxy.**
   *
   * `publicUrl` takes the scheme from `socket.encrypted`, and this service runs
   * plain HTTP behind a proxy that terminates TLS, so it answers `http://` for a
   * request a browser made over `https://`. `GET /install.sh` has corrected that
   * with `x-forwarded-proto` since Q1.627; the four code-minting routes did not,
   * and what they answer is written verbatim into a daemon's
   * `REEMOAT_CONTROL_PLANE`, into the panel's `export …` paste and into
   * `cpctl`'s. Measured: on a stand whose plaintext port does not answer, the
   * daemon's enrollment `POST` failed at the connection and it never enrolled.
   *
   * Both routes, because the panel pastes from the second and the one-shot
   * installer reads the first — and the same header, so a fix on one that missed
   * the other would read as green here.
   */
  {
    const proxied = { ...admin, "x-forwarded-proto": "https" };
    const created = (await (await post("/v1/machines", { name: "proxied-origin" }, proxied)).json()) as {
      machine?: { id?: string };
      controlPlaneUrl?: string;
    };
    check(
      "a created machine's controlPlaneUrl honours a trusted x-forwarded-proto",
      created.controlPlaneUrl?.startsWith("https://"),
      true,
    );
    const minted = (await (
      await post(`/v1/machines/${created.machine?.id ?? "m_missing"}/enrollments`, {}, proxied)
    ).json()) as { controlPlaneUrl?: string };
    check("and so does a code minted for it afterwards", minted.controlPlaneUrl?.startsWith("https://"), true);
    /*
     * The negative control, and the reason this is two apps rather than one
     * assertion: the header is caller-supplied. Believing it with no proxy
     * declared would let anybody make this route hand out an `https://` default
     * for an instance that is plaintext all the way down.
     */
    const bare = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const forged = (await (
      await bare.request("/v1/machines", {
        method: "POST",
        headers: { ...proxied },
        body: JSON.stringify({ name: "forged-origin" }),
      })
    ).json()) as { controlPlaneUrl?: string };
    check("while an undeclared proxy's header moves nothing", forged.controlPlaneUrl?.startsWith("http://"), true);
    /*
     * And it is read the way `x-forwarded-for` is: the entry `trustedHops` from the
     * right. A proxy that appends leaves the client's own claim on the left, so with
     * one hop declared `http, https` is the proxy saying `https` and the client
     * saying nothing that counts.
     */
    const appended = (await (
      await post("/v1/machines", { name: "appended-proto" }, { ...admin, "x-forwarded-proto": "http, https" })
    ).json()) as { machine?: { id?: string }; controlPlaneUrl?: string };
    check("and with a proxy that appends, the proxy's entry outranks the client's", appended.controlPlaneUrl?.startsWith("https://"), true);
    const short = (await (
      await post("/v1/machines", { name: "short-chain" }, { ...admin, "x-forwarded-proto": "" })
    ).json()) as { controlPlaneUrl?: string };
    check("and a header with fewer entries than hops is not believed", short.controlPlaneUrl?.startsWith("http://"), true);
    // The other two routes that mint a code: the admin's, and — further down — the
    // provisioning key's. A fix on the first pair that missed either reads green here.
    const adminMinted = (await (
      await post(`/v1/admin/machines/${appended.machine?.id ?? "m_missing"}/enrollments`, {}, proxied)
    ).json()) as { controlPlaneUrl?: string };
    check("and a code an admin mints honours it too", adminMinted.controlPlaneUrl?.startsWith("https://"), true);
    /*
     * **Two hops, because at one hop "the entry `trustedHops` from the right" is
     * the same entry as `entries.at(-1)`.** Every case above passes for a read that
     * always takes the right-most value — and, with the header `installOrigin` is
     * handed there, for the `[0]` read it replaced too. So a regression to either
     * was green here; the address side already has its witness at "two hops steps
     * one further left", and this is the scheme side's. Four headers, each drawn
     * so that the three reads disagree on at least one of them: the right-most
     * loses `evil, https, http` and `https, http`; the left-most loses
     * `evil, https, http` (an entry that is neither scheme leaves `publicUrl`
     * standing); and `http, https` under two hops *is* the client's own claim —
     * `entries[0]` — which reads as a downgrade until you count the chain the
     * operator declared: two proxies appended, and only two entries came, so the
     * first is the outer proxy's and the client sent none. A lone `https` is one
     * entry against two hops, and is not believed at all.
     */
    const twoHops = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry, trustedProxyHops: 2 });
    const originUnder = async (name: string, proto: string): Promise<string | undefined> =>
      (
        (await (
          await twoHops.request("/v1/machines", {
            method: "POST",
            headers: { ...admin, "x-forwarded-proto": proto },
            body: JSON.stringify({ name }),
          })
        ).json()) as { controlPlaneUrl?: string }
      ).controlPlaneUrl;
    check("under two hops the entry two from the right wins, not the right-most", (await originUnder("two-hops-inner", "evil, https, http"))?.startsWith("https://"), true);
    check("and a lone entry against two hops is not believed", (await originUnder("two-hops-lone", "https"))?.startsWith("http://"), true);
    check("and with exactly two entries the first is the outer proxy's: `http, https` reads http", (await originUnder("two-hops-first-http", "http, https"))?.startsWith("http://"), true);
    check("and `https, http` reads https", (await originUnder("two-hops-first-https", "https, http"))?.startsWith("https://"), true);
  }

  check("but /v1/jwks is still public", (await send("/v1/jwks")).status, 200);
  check("and /v1/enroll still takes a bare code", (await outcome(await post("/v1/enroll", { code: "nope" }, { "content-type": "application/json" })))[1], "code_unusable");
  check("and /health needs nothing", (await send("/health")).status, 200);
  /*
   * And it *reads* something, which it did not.
   *
   * The body was a literal — issuer, clock, token TTL — so nothing in it could
   * ever disagree with the state of the service. A disk that filled kept
   * answering reads while every write threw `SQLITE_FULL`, i.e. every login and
   * every token mint 500'd, `deploy.sh`'s 30s probe went green and compose's
   * healthcheck never fired. One indexed read against `signing_keys` is what
   * makes this route able to be wrong.
   *
   * Absence of a key is deliberately *not* failure — a relay may create the
   * schema before the API mints one, which `compose.yml` documents as an ordinary
   * first boot — so what is asserted is the field, not a row count.
   */
  const health = (await (await send("/health")).json()) as Record<string, unknown>;
  check("and reports whether it can read its own database", [health["ok"], health["database"]], [true, "ok"]);
  check(
    "an unknown /v1 path is refused rather than 404'd to a stranger",
    (await send("/v1/nope")).status,
    401,
  );

  /* -- creating a person --------------------------------------------- */

  const madeResponse = await post("/v1/admin/users", { name: "ada" }, admin);
  const made = (await madeResponse.json()) as { id: string; password: string; apiKey?: string; mustChangePassword?: boolean };
  check("a new user is created with a password", madeResponse.status, 201);
  /*
   * **No API key, and no way to ask for one.** `withKey` used to be offered here
   * and is deleted with the two admin credential routes: an admin may take a
   * credential away and may never issue one, and a flag that quietly kept
   * issuing them would have made that sentence true in the documentation and
   * false in the code.
   */
  check("and no API key at all", made.apiKey, undefined);
  const withKey = (await (await post("/v1/admin/users", { name: "bob", withKey: true }, admin)).json()) as {
    id: string;
    password: string;
    apiKey?: string;
  };
  check("asking for one is ignored rather than honoured", withKey.apiKey, undefined);
  check("an admin-created account owes a password change", made.mustChangePassword, true);

  /*
   * **The wall, and then it is taken down for the rest of this file.**
   *
   * Every fixture below signs in and uses the API, and an account that owes a
   * password change is refused everything past THE SECOND LINE — which is the
   * gate doing its job and would otherwise turn 900 assertions into
   * `password_change_required`. So the obligation is asserted here, exercised
   * against the routes that matter, and then cleared directly in the database:
   * this driver owns that file, and clearing it is the same act the remedy route
   * performs.
   */
  {
    const walled = (await (await login("ada", made.password)).json()) as { token: string };
    const bearerWalled = { authorization: `Bearer ${walled.token}` };
    check(
      "GET /v1/me stays reachable, or nothing could discover the obligation",
      (await send("/v1/me", { headers: bearerWalled })).status,
      200,
    );
    const walledMe = (await (await send("/v1/me", { headers: bearerWalled })).json()) as {
      mustChangePassword?: boolean;
      mustChangePasswordReason?: string | null;
    };
    check("and it says so", [walledMe.mustChangePassword, walledMe.mustChangePasswordReason], [true, "admin_created"]);
    /*
     * Enumerated deliberately across routes that have **nothing to do with
     * passwords**, because a check that only names `/v1/me/*` proves nothing
     * about failing closed — which is the whole property a positional gate has.
     *
     * The list carries a method because one of them is a **write** that is not
     * about credentials at all: taking a machine off the network is the act
     * furthest from "change your password" this surface has, and a gate that
     * covered only reads would pass while it stayed reachable.
     */
    const walledRoutes: [string, string][] = [
      ["GET", "/v1/machines"],
      ["GET", "/v1/me/sessions"],
      ["GET", "/v1/admin/users"],
      ["POST", "/v1/machines/m_x/revoke"],
    ];
    for (const [method, path] of walledRoutes) {
      check(
        `${method} ${path} is refused while a password is owed`,
        await outcome(await send(path, { method, headers: bearerWalled })),
        [403, "password_change_required"],
      );
    }
    /*
     * **And the same list again on an API key, because the gate is
     * credential-blind and nothing in the type system says so.**
     *
     * `requirePasswordCurrent` never reads `via`: an obligation is a property of
     * the *account*, not of the door it came through. A sessions-only sweep
     * passes an implementation that inlines `via === "session"` — which is the
     * shape somebody reaches for the first time an admin's `cpctl` trips over
     * this wall, and which would be a bypass rather than a fix. Such an account
     * cannot mint a key for itself (`withKey` is gone), so the row is written
     * here directly and removed immediately after: what is being asserted is the
     * middleware, not a route that can produce this state.
     */
    const walledKey = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      made.id,
      walledKey.prefix,
      walledKey.hash,
      now,
    );
    for (const [method, path] of walledRoutes) {
      check(
        `${method} ${path} is refused for an API key too`,
        await outcome(await send(path, { method, headers: { authorization: `Bearer ${walledKey.key}` } })),
        [403, "password_change_required"],
      );
    }
    // Removed rather than left: every later assertion in this section counts
    // ada's live keys, and a fixture credential nobody named would be counted.
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(made.id);
    check(
      "minting a permanent credential from a borrowed password is refused",
      (await outcome(await post("/v1/me/keys", {}, { ...bearerWalled, "content-type": "application/json" })))[1],
      "password_change_required",
    );
    check(
      "and signing out is not, because it is the way off this screen",
      (await send("/v1/me/sessions/current", { method: "DELETE", headers: bearerWalled })).status,
      200,
    );
    /*
     * **The fourth reachable route, and it was the one nobody drove.** `app.ts`
     * names four registered above THE SECOND LINE and this block reached two;
     * "sign out everywhere" earns its place for a reason the other three do not
     * share — it is exactly what somebody does when they think the password an
     * admin handed them has leaked, which is the circumstance the obligation
     * exists for. A list of four with two asserted is how the third quietly
     * moves below the line.
     */
    const everywhere = (await (await login("ada", made.password)).json()) as { token: string };
    check(
      "signing out everywhere stays reachable too",
      (await send("/v1/me/sessions", { method: "DELETE", headers: { authorization: `Bearer ${everywhere.token}` } }))
        .status,
      200,
    );

    /*
     * **The remedy, driven in both directions, which is the whole of what this
     * wall is for.** Every case above asserts the refusal; none asserted that
     * the way out works — and for an admin-created account with no address this
     * route is the *only* in-band way out, since `POST /v1/forgot` needs a
     * confirmed address and the admin reset route is deleted. A change that
     * wrote the new hash and left the row behind would leave somebody holding a
     * password that works and a gate that will not let them past, and every
     * assertion in this file would still be green because the driver clears the
     * table by hand two lines below.
     *
     * So: a route that answered 403 a moment ago, then the remedy, then the row,
     * then the same route again. The obligation is read straight out of the
     * database rather than off `GET /v1/me`, because that field and this gate
     * are two readers of one table and asserting the *reader* would pass if both
     * moved together.
     */
    const remedy = (await (await login("ada", made.password)).json()) as { token: string };
    const remedyBearer = { authorization: `Bearer ${remedy.token}`, "content-type": "application/json" };
    const owedCount = (): number =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM password_obligations WHERE user_id = ?").get(made.id)?.["n"] ?? -1);
    check(
      "a route below the line is refused on the session that is about to fix it",
      await outcome(await send("/v1/machines", { headers: remedyBearer })),
      [403, "password_change_required"],
    );
    check("and the obligation is really there to be cleared", owedCount(), 1);

    const chosen = "a password of my own choosing";
    const replaced = await post("/v1/me/password", { currentPassword: made.password, newPassword: chosen }, remedyBearer);
    check("replacing the password an admin chose is allowed through the wall", replaced.status, 200);
    check("the obligation is gone", owedCount(), 0);
    /*
     * The same route, the same credential, one request later. `POST
     * /v1/me/password` keeps the caller's own session alive deliberately —
     * revoking it would read as the change having failed — so this is the
     * screen the person is actually looking at when the wall comes down.
     */
    check(
      "and the route that answered 403 a moment earlier now answers",
      (await send("/v1/machines", { headers: remedyBearer })).status,
      200,
    );
    // Put it back, because every fixture below this block signs in as ada with
    // `made.password`. Two changes rather than one, and the second is also the
    // half that says the first did not somehow re-arm the wall.
    check(
      "changing it back needs the new one, and re-arms nothing",
      [
        (await post("/v1/me/password", { currentPassword: chosen, newPassword: made.password }, remedyBearer)).status,
        owedCount(),
      ],
      [200, 0],
    );
    db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(made.id);
    db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(withKey.id);
  }
  check("a name that is not a name is refused", (await outcome(await post("/v1/admin/users", { name: "ada/laptop" }, admin)))[1], "bad_request");
  check("a duplicate is a 409", (await outcome(await post("/v1/admin/users", { name: "ada" }, admin)))[1], "user_exists");

  /* -- signing in ----------------------------------------------------- */

  const signedIn = (await (await login("ada", made.password)).json()) as { token: string };
  check("the right password signs in", typeof signedIn.token, "string");
  check("and the token has the prefix keyPrefix assumes", signedIn.token.slice(0, 3), "rs_");
  check(
    "the stored row is a hash rather than the token",
    db.prepare("SELECT token_hash FROM user_sessions WHERE user_id = ?").get(made.id)?.["token_hash"] !== signedIn.token,
    true,
  );
  check("a session reaches /v1/me", (await send("/v1/me", { headers: bearer(signedIn.token) })).status, 200);
  /*
   * **The property a deploy of this feature must not break.** Every existing
   * credential in the fleet is an `rk_` key, and it still works — which is what
   * makes this change something nobody has to be told about in advance.
   */
  check("an API key still reaches /v1/me", (await send("/v1/me", { headers: admin })).status, 200);
  check(
    "and /v1/me says which credential it was",
    [
      ((await (await send("/v1/me", { headers: bearer(signedIn.token) })).json()) as { via?: string }).via,
      ((await (await send("/v1/me", { headers: admin })).json()) as { via?: string }).via,
    ],
    ["session", "api_key"],
  );

  /* -- refusals, which must be indistinguishable ---------------------- */

  const wrongPassword = await outcome(await login("ada", "definitely-not-it"));
  const unknownName = await outcome(await login("nobody-at-all", "definitely-not-it"));
  check("a wrong password is refused", wrongPassword, [401, "invalid_login"]);
  // The discipline `POST /v1/tokens` already uses for machines: a caller learns
  // that it did not work and never which half was wrong.
  check("and an unknown name is refused identically", unknownName, wrongPassword);
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_nopw', 'nopw', 0, ?)").run(now);
  check("so is a user who has no password at all", await outcome(await login("nopw", "anything-at-all")), wrongPassword);

  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, withKey.id);
  check("a banned user with the right password is told so", await outcome(await login("bob", withKey.password)), [403, "user_disabled"]);
  // Only after the password verified, so this leaks nothing to somebody who does
  // not already hold it.
  check("but with the wrong one is not", await outcome(await login("bob", "wrong-wrong-wrong")), wrongPassword);
  check("and their live session stops working", await (async () => {
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(withKey.id);
    const live = (await (await login("bob", withKey.password)).json()) as { token: string };
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, withKey.id);
    return outcome(await send("/v1/me", { headers: bearer(live.token) }));
  })(), [403, "user_disabled"]);

  /* -- signing in with the address instead of the name ----------------- */

  /*
   * **A name *or* a verified address, and the second half is the whole of the
   * feature.** `verifiedOwnerOf` is the resolver, which means `verified_at IS NOT
   * NULL` is the rule — and the cases below are the three shapes that rule has to
   * survive, not one happy path.
   *
   * ⚠ **The refusals are compared against `wrongPassword` by value**, not merely
   * asserted to be 401s. An address nobody has, an address nobody *proved*, and a
   * password that is wrong must be one answer: any of the three answering
   * differently is an oracle that tells a stranger which addresses exist on this
   * server, from a route that needs no credential at all.
   */
  {
    const claim = (userId: string, email: string, verified: boolean): void => {
      db.prepare(
        "INSERT INTO user_emails (user_id, email, email_folded, verified_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, email_folded = excluded.email_folded, " +
          "verified_at = excluded.verified_at, updated_at = excluded.updated_at",
      ).run(userId, email, email.toLowerCase(), verified ? now : null, now);
    };
    const whoIs = async (identifier: string, password: string): Promise<string> => {
      const response = await login(identifier, password);
      if (response.status !== 200) return `${response.status}`;
      return ((await response.json()) as { user?: { name?: string } }).user?.name ?? "?";
    };

    claim(made.id, "Ada@Example.com", true);
    check("a verified address signs in, and lands on its own account", await whoIs("Ada@Example.com", made.password), "ada");
    /*
     * The address is folded whole — local part included — by `foldEmail`, which
     * `address.ts` argues is a uniqueness decision rather than an RFC claim. The
     * stored `email` keeps the case somebody typed; the lookup does not read it.
     */
    check("in whatever case it is typed", await whoIs("ADA@EXAMPLE.COM", made.password), "ada");
    check("and the name still works beside it", await whoIs("ada", made.password), "ada");
    check("a real address with the wrong password reads like everything else", await outcome(await login("ada@example.com", "definitely-not-it")), wrongPassword);
    check("and an address nobody has, likewise", await outcome(await login("nobody@example.com", "definitely-not-it")), wrongPassword);

    /*
     * ⚠ **An unverified claim reserves nothing, and this is the assertion that
     * says so.** `idx_user_emails_verified` is a *partial* unique index for
     * exactly this reason: `POST /v1/register` is anonymous, so anybody may write
     * an unverified row naming any address. Were the lookup on `email_folded`
     * alone, that row would be a second candidate for somebody else's address —
     * and, on an account with no other claimant, a way in.
     */
    const carol = (await (await post("/v1/admin/users", { name: "carol" }, admin)).json()) as { id: string; password: string };
    claim(carol.id, "carol@example.com", false);
    check("an unverified address opens nothing", await outcome(await login("carol@example.com", carol.password)), wrongPassword);
    check("while carol's own name still does", await whoIs("carol", carol.password), "carol");

    /*
     * The squat, driven end to end: a second account claims an address somebody
     * else has already proved. The claim is unverified — the partial index would
     * refuse it otherwise — so it must resolve to nobody, and in particular it
     * must not steer the address away from the account that proved it.
     */
    const mallory = (await (await post("/v1/admin/users", { name: "mallory" }, admin)).json()) as { id: string; password: string };
    claim(mallory.id, "ada@example.com", false);
    check("claiming an address somebody proved does not borrow it", await outcome(await login("ada@example.com", mallory.password)), wrongPassword);
    check("and the account that proved it still signs in", await whoIs("ada@example.com", made.password), "ada");

    db.prepare("DELETE FROM password_obligations WHERE user_id IN (?, ?)").run(carol.id, mallory.id);
  }

  /* -- sessions -------------------------------------------------------- */

  const phone = (await (await login("ada", made.password)).json()) as { token: string };
  check("signing out ends the token it was presented with", (await send("/v1/me/sessions/current", { method: "DELETE", headers: bearer(phone.token) })).status, 200);
  // Distinct from `invalid_api_key`, and safe to distinguish: reaching it required
  // presenting a real 256-bit token. The client shows a sign-in form for one and
  // treats the other as a garbage stored value.
  check("and the code says a session ended", await outcome(await send("/v1/me", { headers: bearer(phone.token) })), [401, "session_revoked"]);
  check("signing out with an API key is a 409", await outcome(await send("/v1/me/sessions/current", { method: "DELETE", headers: admin })), [409, "not_a_session"]);
  check("somebody else's session id is a 404, not a 403", await outcome(await send("/v1/me/sessions/s_nope", { method: "DELETE", headers: bearer(signedIn.token) })), [404, "session_not_found"]);

  /* -- where a session signed in from ----------------------------------- *
   *
   * The list is a way to *end* sessions, so what it draws has to be recognisable
   * and is never trusted. These assertions are about the two halves separately:
   * the pure address logic, which has branches no test machine can reach through
   * a socket, and the round trip, which is the only thing that proves the row and
   * the session are written together.
   * --------------------------------------------------------------------- */

  /*
   * ⚠ **The first three of these used to assert the defect.**
   *
   * "A forwarded address wins over the socket" was the rule, and with the entry
   * read from the *left* it made the address half of every throttle key a string
   * the caller typed: rotate it and the login counter and the per-address
   * backstop are both defeated; spell somebody else's into it and thirty failed
   * sign-ins refuse that address its own sign-in and its own `/v1/forgot` for
   * fifteen minutes, with no credential and no name known. The header is now
   * believed only as far as `trustedProxyHops` says it is, and counted from the
   * **right**, which is the end an ordinary reverse proxy appends to.
   */
  check("with no proxy configured the header is ignored outright", callerAddressOf("203.0.113.7", "10.0.0.9"), "10.0.0.9");
  check("however many entries it carries", callerAddressOf("1.1.1.1, 2.2.2.2, 3.3.3.3", "10.0.0.9"), "10.0.0.9");
  // One trusted hop: the last entry is what *your* proxy observed and appended.
  // The leftmost is whatever the client sent, which is the read this replaced.
  check("one trusted hop takes the entry that proxy appended", callerAddressOf("203.0.113.7, 10.0.0.1", "10.0.0.9", 1), "10.0.0.1");
  check("and not the one the caller wrote", callerAddressOf("203.0.113.7, 10.0.0.1", "10.0.0.9", 1) === "203.0.113.7", false);
  // Two hops is a proxy of yours behind a CDN.
  check("two hops steps one further left", callerAddressOf("evil, 203.0.113.7, 10.0.0.1", "10.0.0.9", 2), "203.0.113.7");
  /*
   * **Fewer entries than hops is refused rather than partially believed**, and
   * this is the case that decides whether the setting is worth anything: a caller
   * who simply omits the header, or sends one entry where the operator described
   * two, must not have that single entry read as the trusted one. Falling back to
   * the socket is the only answer that cannot be steered.
   */
  check("a header shorter than the configured chain falls back to the socket", callerAddressOf("203.0.113.7", "10.0.0.9", 2), "10.0.0.9");
  check("and so does no header at all", callerAddressOf(undefined, "10.0.0.9", 1), "10.0.0.9");
  check("an empty forwarded header falls through rather than winning", callerAddressOf("", "10.0.0.9", 1), "10.0.0.9");
  // Node reports an IPv4 client on a dual-stack listener this way, and the point
  // of showing an address at all is that somebody recognises their own network.
  check("an IPv4-mapped IPv6 address is unmapped", callerAddressOf(undefined, "::ffff:192.168.1.4"), "192.168.1.4");
  check("a real IPv6 address is left alone", callerAddressOf(undefined, "2001:db8::1"), "2001:db8::1");
  check("neither is 'unknown' rather than empty", callerAddressOf(undefined, undefined), "unknown");
  report(
    "and an over-long forwarded header is clamped",
    callerAddressOf("x".repeat(500), undefined, 1).length === 64,
    `${callerAddressOf("x".repeat(500), undefined, 1).length} chars`,
  );
  /*
   * The operator's own half: with hops at zero and a proxy really in front, every
   * counter keys on that proxy and one person's failed sign-ins refuse everybody
   * else's — which is why `main.ts` says so once rather than leaving it silent.
   */
  check("a forwarding header arriving while it is ignored is worth saying", forwardingIgnored("203.0.113.7", 0), true);
  check("but not when the operator configured a hop", forwardingIgnored("203.0.113.7", 1), false);
  check("and not when nothing was forwarded", forwardingIgnored(undefined, 0), false);

  const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const described = (await (await post("/v1/login", { name: "ada", password: made.password }, { "content-type": "application/json", "user-agent": CHROME, "x-forwarded-for": "203.0.113.7" })).json()) as { token: string };
  const listed = (await (await send("/v1/me/sessions", { headers: bearer(described.token) })).json()) as {
    sessions: Array<{ id: string; current: boolean; ip: string | null; userAgent: string | null }>;
  };
  const self = listed.sessions.find((row) => row.current);
  check("a sign-in records the address it came from", self?.ip, "203.0.113.7");
  check("and the agent it announced", self?.userAgent, CHROME);
  /*
   * The row and the session are written in one transaction, asserted against the
   * database rather than against the response — the response would agree with
   * itself whatever happened, since the route maps a missing join to `null`.
   * Splitting the two would draw a device for a session that does not exist, or
   * leave a real one permanently undescribable.
   */
  const paired = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM user_sessions WHERE user_id = ?) AS sessions, " +
        "(SELECT COUNT(*) FROM user_session_origins o JOIN user_sessions s ON s.id = o.session_id WHERE s.user_id = ?) AS origins",
    )
    .get(made.id, made.id);
  report(
    "every session minted so far has an origin row",
    Number(paired?.["sessions"]) > 0 && paired?.["sessions"] === paired?.["origins"],
    `${String(paired?.["sessions"])} sessions, ${String(paired?.["origins"])} origins`,
  );

  // A session that predates `user_session_origins` is the row somebody most wants
  // to end, so it is listed with nulls rather than dropped by the join.
  db.prepare("DELETE FROM user_session_origins WHERE session_id = (SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1)").run(made.id);
  const afterForget = (await (await send("/v1/me/sessions", { headers: bearer(described.token) })).json()) as {
    sessions: Array<{ current: boolean; ip: string | null; userAgent: string | null }>;
  };
  check("a session with no origin row is still listed", afterForget.sessions.find((row) => row.current)?.ip, null);

  // Caller-supplied and unbounded, so it is clamped where it enters the database
  // rather than where somebody remembers to.
  const longAgent = (await (await post("/v1/login", { name: "ada", password: made.password }, { "content-type": "application/json", "user-agent": "Z".repeat(4000) })).json()) as { token: string };
  const clamped = (await (await send("/v1/me/sessions", { headers: bearer(longAgent.token) })).json()) as {
    sessions: Array<{ current: boolean; userAgent: string | null }>;
  };
  check("an over-long user agent is clamped at ingest", clamped.sessions.find((row) => row.current)?.userAgent?.length, 256);

  // `PRAGMA foreign_keys = OFF`, so nothing cascades and the sweep is ours. An
  // orphan here is a table that only grows.
  db.prepare("INSERT INTO user_session_origins (session_id, ip, user_agent) VALUES ('s_orphan', '1.2.3.4', 'x')").run();
  pruneSessions(db);
  check("pruning collects origins whose session is gone", db.prepare("SELECT COUNT(*) AS n FROM user_session_origins WHERE session_id = 's_orphan'").get()?.["n"], 0);

  /* -- deleting a person ------------------------------------------------ *
   *
   * The only irreversible act on the admin surface: `disable` has an `enable` and
   * this has nothing. What the assertions are about is that it removes *every*
   * credential rather than only the row — a `users` row deleted with an
   * `api_keys` row left behind is a credential belonging to nobody, invisible to
   * every list an admin can read.
   * --------------------------------------------------------------------- */

  {
    const doomed = (await (await post("/v1/admin/users", { name: "leaver", withKey: true }, admin)).json()) as {
      id: string;
      password: string;
      apiKey: string;
    };
    const theirSession = (await (await login("leaver", doomed.password)).json()) as { token: string };
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_leaver', 'leaver-box', ?)").run(now);
    db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES ('m_leaver', ?, 'box', ?)").run(doomed.id, now);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, 'm_leaver', 'session:read', ?)").run(doomed.id, now);

    check("deleting yourself is refused", await outcome(await send(`/v1/admin/users/u_root`, { method: "DELETE", headers: admin })), [409, "cannot_delete_self"]);
    check("an unknown user is a 404", await outcome(await send("/v1/admin/users/u_nope", { method: "DELETE", headers: admin })), [404, "user_not_found"]);
    check("a non-admin cannot delete anybody", (await send(`/v1/admin/users/${doomed.id}`, { method: "DELETE", headers: bearer(signedIn.token) })).status, 403);

    const gone = (await (await send(`/v1/admin/users/${doomed.id}`, { method: "DELETE", headers: admin })).json()) as {
      deleted: boolean;
      name: string;
      machinesRevoked: number;
    };
    check("the delete reports who it was", [gone.deleted, gone.name], [true, "leaver"]);
    check("and how many machines it took off the network", gone.machinesRevoked, 1);

    check("the row is gone", db.prepare("SELECT id FROM users WHERE id = ?").get(doomed.id), undefined);
    // Each of these is a credential that would otherwise authenticate as nobody,
    // or a grant that would otherwise name a subject no list can show.
    check("their password is gone", db.prepare("SELECT user_id FROM user_passwords WHERE user_id = ?").get(doomed.id), undefined);
    check("their API key is gone", db.prepare("SELECT id FROM api_keys WHERE user_id = ?").get(doomed.id), undefined);
    check("their sessions are gone", db.prepare("SELECT id FROM user_sessions WHERE user_id = ?").get(doomed.id), undefined);
    check("their grants are gone", db.prepare("SELECT user_id FROM grants WHERE user_id = ?").get(doomed.id), undefined);
    check("and their ownership is released", db.prepare("SELECT machine_id FROM machine_owners WHERE user_id = ?").get(doomed.id), undefined);
    /*
     * ⭐ **The reversal, and the invariant it exists for.**
     *
     * This used to assert the machine survived *ownerless*, on the argument that
     * deleting a person should not take a daemon somebody may still be running
     * off the network. What that missed is what ownerless became: no owner means
     * no machine limit and no ban check, both being facts about the owner — so
     * deleting a person was the one act that manufactured a live, enrolled,
     * fully reachable machine that no rule applies to.
     *
     * The row still exists, because the audit trail of which machines existed is
     * in `machines` and nothing rewrites it. What changed is that it is revoked,
     * and therefore inert: `resolveTunnelKey` refuses its dial.
     */
    const leaver = db.prepare("SELECT revoked_at FROM machines WHERE id = 'm_leaver'").get();
    report("the machine row survives, for the audit trail", leaver !== undefined, "m_leaver still listed");
    check("but it is revoked rather than left ownerless", leaver?.["revoked_at"] !== null, true);
    /*
     * The invariant, scoped to what this route did rather than to the whole
     * database — this driver builds dozens of ownerless machines by hand for the
     * relay sections, which are testing routing rather than ownership and have
     * no business having owners. What is being asserted is that no *route* leaves
     * a machine live and ownerless, and the delete is one of the two that could.
     */
    check(
      "the deleted user left nothing live and ownerless behind",
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM machines WHERE id = 'm_leaver' AND revoked_at IS NULL",
        )
        .get()?.["n"],
      0,
    );
    // Belt over braces, exactly as `disable` is: `callerAuth` joins `users`, so a
    // credential whose subject is gone fails closed even before the rows do.
    check("their session no longer authenticates", (await send("/v1/me", { headers: bearer(theirSession.token) })).status, 401);
    check("nor does their API key", (await send("/v1/me", { headers: bearer(doomed.apiKey) })).status, 401);
    check("and signing in as them is refused", (await outcome(await login("leaver", doomed.password)))[0], 401);
    // The name is free again, which is the point of deleting rather than
    // disabling: `users.name` is UNIQUE, so a disabled row holds it for ever.
    check("the name can be used again", (await post("/v1/admin/users", { name: "leaver" }, admin)).status, 201);
  }

  /* -- changing a password --------------------------------------------- */

  const laptop = (await (await login("ada", made.password)).json()) as { token: string };
  const tablet = (await (await login("ada", made.password)).json()) as { token: string };
  check("changing a password needs the current one", await outcome(await post("/v1/me/password", { newPassword: "a-fine-new-password" }, bearer(laptop.token))), [400, "bad_request"]);
  check("a wrong current password is refused", await outcome(await post("/v1/me/password", { currentPassword: "nope", newPassword: "a-fine-new-password" }, bearer(laptop.token))), [401, "invalid_password"]);
  check("a short new one is refused with a reason", await outcome(await post("/v1/me/password", { currentPassword: made.password, newPassword: "short" }, bearer(laptop.token))), [400, "weak_password"]);

  check("the change lands", (await post("/v1/me/password", { currentPassword: made.password, newPassword: "a-fine-new-password" }, bearer(laptop.token))).status, 200);
  // The tab that made the change keeps working; every other device does not.
  // Signing you out of the screen you just used reads as the change having failed.
  check("the tab that made it stays signed in", (await send("/v1/me", { headers: bearer(laptop.token) })).status, 200);
  check("every other device is signed out", await outcome(await send("/v1/me", { headers: bearer(tablet.token) })), [401, "session_revoked"]);
  check("the old password stops working", (await login("ada", made.password)).status, 401);
  check("and the new one works", (await login("ada", "a-fine-new-password")).status, 200);

  /*
   * A trailing space is part of the password.
   *
   * `hashCredential` trims, which is right for a token pasted out of a terminal
   * and catastrophic here — a password stored trimmed would appear to work until
   * it met a field that does not trim. `password.ts` normalizes and never trims.
   */
  await post("/v1/me/password", { currentPassword: "a-fine-new-password", newPassword: "trailing space  " }, bearer(laptop.token));
  check("a trailing space is part of the password", (await login("ada", "trailing space  ")).status, 200);
  check("and the trimmed form is not the password", (await login("ada", "trailing space")).status, 401);

  /* -- a user with only an API key sets a first password --------------- */

  const legacyKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_old', 'oldtimer', 0, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_old', ?, ?, ?)").run(
    newId("ak"),
    legacyKey.prefix,
    legacyKey.hash,
    now,
  );
  const legacy = { authorization: `Bearer ${legacyKey.key}`, "content-type": "application/json" };
  // The migration, and the reason the absence of a `user_passwords` row is
  // meaningful rather than a gap: their key was already full authority.
  check("a user with no password sets a first one with their key alone", (await post("/v1/me/password", { newPassword: "an-entirely-new-password" }, legacy)).status, 200);
  check("and then the current one is required", await outcome(await post("/v1/me/password", { newPassword: "another-new-password" }, legacy)), [400, "bad_request"]);
  check("they can now sign in", (await login("oldtimer", "an-entirely-new-password")).status, 200);

  /* -- the two credential routes an admin no longer has ------------------ */

  /*
   * **An admin can take a credential away and can never issue one.**
   *
   * Both of these answered 2xx until this change: one reset somebody's password
   * and handed it over, the other minted them a permanent key. A deletion needs
   * proving — nothing else in this file would notice a route quietly still
   * registered, and "we removed it" is exactly the claim a revert makes false in
   * silence.
   *
   * What replaces the reset is `POST /v1/forgot`, which needs a verified
   * address. Where there is no SMTP there is now no recovery for a forgotten
   * password at all; that is a known limitation rather than an oversight.
   */
  check(
    "an admin can no longer reset somebody's password",
    (await post(`/v1/admin/users/${made.id}/password`, {}, admin)).status,
    404,
  );
  check(
    "nor mint them a key",
    (await post(`/v1/admin/users/${made.id}/keys`, {}, admin)).status,
    404,
  );

  const adaPassword = "trailing space  ";
  check("a non-admin cannot reach an admin route", await outcome(await send("/v1/admin/users", { headers: bearer(((await (await login("ada", adaPassword)).json()) as { token: string }).token) })), [403, "forbidden"]);
  check("disabling yourself is refused", await outcome(await post("/v1/admin/users/u_root/disable", {}, admin)), [409, "cannot_disable_self"]);
  check("enabling somebody who is not disabled is a 404", await outcome(await post("/v1/admin/users/u_root/enable", {}, admin)), [404, "user_not_found"]);

  /* -- machines somebody owns -------------------------------------------- */

  const ada = bearer(((await (await login("ada", adaPassword)).json()) as { token: string }).token);
  db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(withKey.id);
  /*
   * **Bob mints his own key**, because nothing else can any more.
   *
   * `withKey` is gone, so the fixture that used to arrive holding a key now has
   * to do what a real person does: sign in and ask. That also exercises the
   * route that had to exist for the deletion above to be survivable — it is the
   * only place an API key comes from outside `main.ts`'s bootstrap.
   */
  const bobSession = bearer(((await (await login("bob", withKey.password)).json()) as { token: string }).token);
  check(
    "minting a key without the current password is refused",
    (await post("/v1/me/keys", {}, { ...bobSession, "content-type": "application/json" })).status,
    400,
  );
  const bobMinted = (await (await post(
    "/v1/me/keys",
    { currentPassword: withKey.password },
    { ...bobSession, "content-type": "application/json" },
  )).json()) as { apiKey: string };
  check("and with it, a key that looks like every other one here", bobMinted.apiKey.slice(0, 3), "rk_");
  const bobKey = { authorization: `Bearer ${bobMinted.apiKey}`, "content-type": "application/json" };

  const mine = (await (await post("/v1/machines", { name: "laptop" }, ada)).json()) as {
    machine: { id: string; scopes: string[] };
    enrollment: { code: string };
  };
  check("a user creates their own machine", typeof mine.machine.id, "string");
  /*
   * All three scopes, not `cpctl admin grant`'s two. `machine:admin` guards
   * `DELETE /sessions/:id/workspace` on the daemon, so without it the owner of a
   * machine gets a 403 removing a workspace on their own hardware.
   */
  check("and holds every scope on it", [...mine.machine.scopes].sort(), ["machine:admin", "session:read", "session:write"]);
  check("without an admin granting anything", ((await (await send("/v1/machines", { headers: ada })).json()) as { machines: { id: string }[] }).machines.some((m) => m.id === mine.machine.id), true);

  // The collision the global UNIQUE on `machines.name` would otherwise produce —
  // and the 409 that would have told one user that another has a "laptop".
  check("somebody else may call one 'laptop' too", (await post("/v1/machines", { name: "laptop" }, bobKey)).status, 201);
  check("but the same person may not, twice", await outcome(await post("/v1/machines", { name: "laptop" }, ada)), [409, "machine_exists"]);
  /*
   * **Wider than the unique index, and the gap it closes was real.** That index
   * scopes a label to its owner, which is what lets two people each have a
   * "laptop" — and says nothing about a machine somebody shared with you or one
   * an admin registered before ownership existed, both of which appear in your
   * list under `machines.name`. Reproduced against the shape of a live
   * deployment: somebody with a legacy machine called `mac` could create their
   * own `mac` and end up with two rows reading `mac`, indistinguishable, with
   * `POST /v1/tokens {machine:"mac"}` silently resolving to whichever came first.
   */
  db.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_shared', 'shared-box', ?)").run(now);
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, 'm_shared', 'session:read', ?)").run(made.id, now);
  check("nor one they can already see that nobody owns", await outcome(await post("/v1/machines", { name: "shared-box" }, ada)), [409, "machine_exists"]);
  check("and case does not dodge it", await outcome(await post("/v1/machines", { name: "LAPTOP" }, ada)), [409, "machine_exists"]);
  check(
    "so one person never sees two machines with one name",
    await (async () => {
      const names = ((await (await send("/v1/machines", { headers: ada })).json()) as { machines: { name: string }[] }).machines.map((m) => m.name);
      return new Set(names).size === names.length;
    })(),
    true,
  );
  check(
    "the stored names cannot collide",
    new Set(db.prepare("SELECT name FROM machines").all().map((r) => String(r["name"]))).size,
    db.prepare("SELECT COUNT(*) AS n FROM machines").get()?.["n"],
  );
  /*
   * Each owner sees the label *they* chose, not the row's real name.
   *
   * The stored name is unique fleet-wide and nobody picked it; showing it would
   * put `laptop-4d969625` on screen for a machine somebody called "laptop".
   */
  const adaSees = ((await (await send("/v1/machines", { headers: ada })).json()) as {
    machines: { id: string; name: string; owned?: boolean }[];
  }).machines.find((m) => m.id === mine.machine.id);
  check("each owner sees their own label", adaSees?.name, "laptop");
  // What the settings screen draws its controls from. A machine that is not owned
  // gets none, because the routes behind them answer 404 — the 404 assertions
  // below are the other half of that pair.
  check("and is told it is theirs to manage", adaSees?.owned, true);
  check("a token can be minted by the label alone", (await outcome(await post("/v1/tokens", { machine: "laptop" }, ada)))[1], "machine_not_enrolled");

  check("somebody else's machine is a 404, not a 403", await outcome(await send(`/v1/machines/${mine.machine.id}`, { method: "PATCH", headers: bobKey, body: JSON.stringify({ name: "stolen" }) })), [404, "machine_not_found"]);
  check("and so is minting a code for it", await outcome(await post(`/v1/machines/${mine.machine.id}/enrollments`, {}, bobKey)), [404, "machine_not_found"]);
  check("and revoking it", await outcome(await post(`/v1/machines/${mine.machine.id}/revoke`, {}, bobKey)), [404, "machine_not_found"]);
  // A machine registered before ownership existed stays admin-managed, which is
  // the correct answer rather than a gap: nobody created it through this route.
  check("a machine nobody owns is not user-manageable", await outcome(await send(`/v1/machines/${mine.machine.id === "m_mine" ? "m_other" : "m_mine"}`, { method: "PATCH", headers: ada, body: JSON.stringify({ name: "x" }) })), [404, "machine_not_found"]);

  /* -- one live enrollment code per machine ------------------------------ */

  const second = (await (await post(`/v1/machines/${mine.machine.id}/enrollments`, {}, ada)).json()) as { code: string };
  const redeem = (code: string): Promise<Response> =>
    post("/v1/enroll", { code }, { "content-type": "application/json" });
  // Minting burns the previous one, which is what makes "how many codes may
  // somebody hold" a question with no answer rather than a number to pick.
  check("minting a code burns the one before it", (await outcome(await redeem(mine.enrollment.code)))[1], "code_unusable");
  check("and the newest redeems", (await redeem(second.code)).status, 200);
  check("a code cannot be redeemed twice", (await outcome(await redeem(second.code)))[1], "code_unusable");

  /* -- the throttle ------------------------------------------------------ */

  {
    // Its own app, because the throttle is per instance and the logins above
    // would otherwise have already armed it.
    const fresh = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const attempt = (name: string, password: string): Promise<Response> =>
      Promise.resolve(
        fresh.request("/v1/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, password }),
        }),
      );
    let last = await attempt("ada", "wrong-wrong-wrong");
    for (let i = 0; i < 6; i += 1) last = await attempt("ada", "wrong-wrong-wrong");
    check("repeated wrong passwords are throttled", last.status, 429);
    check("and it says how long to wait", Number(last.headers.get("retry-after")) > 0, true);
    // Even the right one, which is the point: the block is on the attempt, not on
    // whether the guess happened to be correct.
    check("the right password is refused while blocked", (await attempt("ada", adaPassword)).status, 429);
    /*
     * Keyed on the name that was submitted **and the address it came from**, so
     * a 429 proves nothing about whether the account exists — which is what lets
     * it be a 429 rather than another indistinguishable 401. The address half is
     * what stops this being a lockout weapon and is asserted in `the login
     * throttle` and `guessing, under concurrency` below; here both attempts
     * arrive from the same (absent) address, so the name is what separates them.
     */
    check("a different name is unaffected", (await attempt("someone-else", "wrong-wrong-wrong")).status, 401);
  }

  /* -- the cost of the KDF ------------------------------------------------ */

  {
    const started = Date.now();
    await login("ada", "wrong-again-wrong");
    const elapsed = Date.now() - started;
    // Catches somebody raising N far enough to turn signing in into a timeout.
    // Generous, because CI is slower than a laptop and this is a ceiling rather
    // than a measurement.
    report("hashing a password costs a bounded amount of time", elapsed < 2000, `${elapsed}ms`);
  }
}

/* ------------------------------------------------------------------ *
 * The throttle, as a function
 *
 * `throttle.ts` was imported by no driver at all, so every branch of the thing
 * that decides whether somebody may try a password again was asserted nowhere.
 * Every one of them takes `now`, which is what makes this possible offline: a
 * fifteen-minute window and a fifteen-minute block are both reachable from a
 * driver that finishes in a millisecond.
 *
 * The case that earns the section is not "does it block" — it is that **it must
 * not become a lockout weapon**, which keyed on the bare name it was. That half
 * is asserted through the route further down; this half is about the keys, which
 * are where the fix actually lives.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe login throttle\n");
{
  // A fixed clock, so nothing here waits and nothing is probabilistic.
  const T0 = 1_800_000_000_000;
  const addressA = "198.51.100.4";
  const addressB = "203.0.113.9";

  /* -- the keys, which are the whole of the lockout fix ---------------- */

  /*
   * Case folding, stated as the invariant `normalize` carries: a throttle that
   * `Ada` slips past while `ada` is blocked is not a throttle. `users.name` is
   * compared exactly and a guesser will not be careful, so the two have to land
   * on one counter — and that is a property of the key rather than of a lookup.
   */
  check("a key folds case", loginKey("Ada", addressA), loginKey("ada", addressA));
  {
    const throttle = new LoginThrottle();
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(loginKey("Ada", addressA), T0);
    check("so blocking `Ada` blocks `ada`", throttle.check(loginKey("ada", addressA), T0).allowed, false);
    /*
     * **The measured defect, as two assertions.** Eleven unauthenticated
     * `POST /v1/login` requests naming `ada` used to answer 429 to ada's own
     * sign-in with the correct password, and to her password change on a valid
     * session — one instance, one key space, two routes. Both are now different
     * key spaces, and the namespaces are what makes that true of the *string*
     * rather than of `users.name`.
     */
    check("a login block does not follow the name to another address", throttle.check(loginKey("ada", addressB), T0).allowed, true);
    check("and cannot reach a password change at all", throttle.check(passwordChangeKey("u_ada"), T0).allowed, true);
  }
  /*
   * ⚠ **One account named two ways spends two counters, and that is chosen.**
   * `POST /v1/login` now takes a name *or* a verified address, and this key is
   * built from what was *submitted* — so `ada` and `ada@example.com` are two
   * buckets for one person. Folding them means resolving the string to an account
   * before the key exists, which is a counter keyed on the account: the bare-name
   * key this file exists to have stopped having, reached from the other side. What
   * bounds the doubling is `addressKey`, whose budget one caller shares across
   * every spelling they try, and which is asserted over the wire further down.
   */
  {
    const throttle = new LoginThrottle();
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(loginKey("ada", addressA), T0);
    check("guessing at a name does not block that person's address", throttle.check(loginKey("ada@example.com", addressA), T0).allowed, true);
  }
  /*
   * ⚠ **The address half survives an identifier long enough to be a real address.**
   * At `MAX_NAME_KEY_CHARS` (120) the cut landed *inside* a 254-character address
   * and threw the address half away — so every host guessing at any long address
   * shared one counter, which is the exact failure `MAX_EMAIL_KEY_CHARS` was
   * introduced to end one value-kind along. Two addresses agreeing for their first
   * 120 characters are the shape that finds it.
   */
  {
    const long = (tag: string): string => `${"a".repeat(140)}${tag}@example.com`;
    check(
      "two long addresses are two counters, not one",
      loginKey(long("x"), addressA) === loginKey(long("y"), addressA),
      false,
    );
    check(
      "and the address half is still in the key",
      loginKey(long("x"), addressA) === loginKey(long("x"), addressB),
      false,
    );
  }
  /*
   * The namespace is not decoration, because the address half is caller-supplied:
   * with a bare `<name>|<address>` a login naming `pwchg` and forwarding
   * `u_deadbeef` writes exactly the key the password-change route reads.
   */
  check("an anonymous caller cannot spell a password-change key", loginKey("pwchg", "u_deadbeef") === passwordChangeKey("u_deadbeef"), false);
  // Both halves are chosen by the caller, so without the separator strip `a|b`
  // at address `c` and `a` at address `b|c` would be one counter.
  check("and the halves cannot be re-cut", loginKey("a|b", "c") === loginKey("a", "b|c"), false);

  /* -- the curve ------------------------------------------------------- */

  const blockSeconds = (failures: number): number => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < failures; i += 1) throttle.fail("one-key", T0);
    return throttle.check("one-key", T0).retryAfterSeconds;
  };
  // Nothing until the threshold is passed, then the base block doubling per
  // failure, then the ceiling. `0` is `check` answering ALLOWED.
  check(
    "the block doubles past the threshold and then stops",
    [5, 6, 7, 8, 9, 10, 11, 12].map(blockSeconds),
    [0, 30, 60, 120, 240, 480, 900, 900],
  );
  check("the ceiling is the documented one", blockSeconds(40), DEFAULT_THROTTLE.maxBlockMs / 1000);
  /*
   * What the exponent clamp is for, asserted at the only place it is observable.
   * `2 ** (failures - threshold - 1)` is `Infinity` well before this, and an
   * `Infinity` here would reach `Retry-After` and `retryAfterSeconds` — which
   * `JSON.stringify` writes as `null`, i.e. a client told to wait for ever by a
   * refusal that is supposed to expire.
   */
  check("and a long attack is still a number", blockSeconds(2_000), DEFAULT_THROTTLE.maxBlockMs / 1000);

  /* -- forgetting ------------------------------------------------------ */

  {
    const throttle = new LoginThrottle();
    const key = loginKey("ada", addressA);
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(key, T0);
    check("blocked", throttle.check(key, T0).allowed, false);
    // Five wrong guesses spread over a year is somebody's memory, not an attack:
    // a window that has elapsed starts again rather than accumulating.
    throttle.fail(key, T0 + DEFAULT_THROTTLE.windowMs + 1);
    check("an elapsed window starts again", throttle.check(key, T0 + DEFAULT_THROTTLE.windowMs + 1).allowed, true);
  }
  {
    const throttle = new LoginThrottle();
    const key = loginKey("ada", addressA);
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(key, T0);
    throttle.succeed(key);
    /*
     * Somebody who got it right on the sixth try mistyped it five times, and a
     * counter left armed blocks their *next* mistype for no reason. It is also
     * what un-records the optimistic failure the route now writes before it
     * awaits — see the concurrency case below, which is the reason it matters.
     */
    check("a success forgets the failures", throttle.check(key, T0).allowed, true);
  }

  /* -- the bound on the table itself ------------------------------------ */

  {
    // The map is keyed by a string an unauthenticated caller chose, so the
    // failure this prevents is "the defence against guessing is a way to make
    // the process hold as much memory as somebody cares to send".
    const throttle = new LoginThrottle({ maxEntries: 8 });
    for (let i = 0; i < 9; i += 1) throttle.fail(loginKey(`name-${i}`, addressA), T0);
    report(
      "a table past its cap is swept rather than grown",
      throttle.size() <= 8,
      // Zero, and deliberately: nothing has settled at one instant, so
      // `enforceCap` clears outright. That is the documented trade — ten
      // thousand requests buys one reset, which lowers the wall rather than
      // removing it.
      `${throttle.size()} keys held after 9 distinct ones`,
    );
  }

  /* -- the backstop ------------------------------------------------------ */

  /*
   * Looser on purpose, and the number is the point. This key is shared by
   * everybody who appears to be at one address — a NAT, an office, a proxy that
   * forwards nothing — so five would make one person's bad afternoon everybody
   * else's lockout, which is the failure this whole file's throttle header
   * exists to prevent.
   */
  report(
    "the address backstop is looser than the identity one",
    ADDRESS_THROTTLE.threshold > DEFAULT_THROTTLE.threshold,
    `${ADDRESS_THROTTLE.threshold} against ${DEFAULT_THROTTLE.threshold}`,
  );
  {
    const spray = new LoginThrottle(ADDRESS_THROTTLE);
    const key = addressKey(addressA);
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) spray.fail(key, T0);
    check("so six failures from one address are not a block", spray.check(key, T0).allowed, true);
    for (let i = DEFAULT_THROTTLE.threshold + 1; i <= ADDRESS_THROTTLE.threshold; i += 1) spray.fail(key, T0);
    // What a per-identity counter structurally cannot catch: one host naming a
    // thousand *distinct* accounts never reaches a per-identity threshold, so
    // before this every one of those guesses reached the KDF.
    check("and thirty-one are", spray.check(key, T0).allowed, false);
  }

  /*
   * ⭐ **A success may not erase a crowd's counter, and this is the difference
   * between the two verbs.**
   *
   * `/v1/login` called `succeed` on `addressKey` for a release. `succeed` deletes
   * the entry, so a sprayer holding one valid credential reset the only counter
   * that sees a spray across *distinct* names — indefinitely, from one address —
   * and reset the `/v1/register` and `/v1/forgot` budgets that share the bucket
   * and are documented as never cleared.
   *
   * Both directions are asserted, because the obvious fix breaks the other one:
   * dropping the call entirely leaves every successful sign-in's optimistic
   * `fail` standing, and one office NAT would then lock itself out.
   */
  {
    const spray = new LoginThrottle(ADDRESS_THROTTLE);
    const key = addressKey(addressA);
    for (let i = 0; i < ADDRESS_THROTTLE.threshold; i += 1) spray.fail(key, T0);
    spray.forgive(key);
    // One forgiven, so the next failure lands back on the threshold rather than
    // starting from nothing: 29 other people's attempts survive one sign-in.
    spray.fail(key, T0);
    spray.fail(key, T0);
    check("a success forgives one attempt, not the crowd's history", spray.check(key, T0).allowed, false);

    const own = new LoginThrottle(ADDRESS_THROTTLE);
    const mine = addressKey(addressA);
    for (let i = 0; i < ADDRESS_THROTTLE.threshold + 5; i += 1) {
      own.fail(mine, T0);
      own.forgive(mine);
    }
    // The office-NAT property, which is why `forgive` is not simply "do nothing":
    // sign-ins that actually succeed must cost the shared bucket nothing.
    check("but a run of real sign-ins never blocks the address they share", own.check(mine, T0).allowed, true);
  }

  /* -- every builder, against one adversarial argument ------------------ */

  /*
   * **The whole file's rule, asserted as a partition rather than pairwise.**
   *
   * Two of these namespaces are words a caller can type — `pwchg` is a login
   * name, `mail` and `reset` are the local part of an address — so the property
   * that matters is not "these two differ" but "no argument anybody can send
   * makes any two builders write the same string". Pairwise cases would have to
   * be re-derived every time a builder arrives; this is a **list**, and builder
   * ten is covered by being added to it.
   *
   * The arguments are chosen to attack the composition rather than the values:
   * a namespace spelled as a value, a value carrying the separator (which is why
   * `field` strips it), and a string past every cap so the slicing cannot be what
   * makes two keys agree.
   */
  {
    const builders: { name: string; of: (value: string) => string }[] = [
      // The two-argument builders are fed the same string twice on purpose: it is
      // the arrangement most likely to collide with a one-argument builder.
      { name: "loginKey", of: (value) => loginKey(value, value) },
      { name: "addressKey", of: addressKey },
      { name: "passwordChangeKey", of: passwordChangeKey },
      { name: "registerKey", of: (value) => registerKey(value, value) },
      { name: "mailKey", of: mailKey },
      { name: "resetMailKey", of: resetMailKey },
      { name: "confirmKey", of: confirmKey },
      { name: "resetKey", of: resetKey },
      { name: "mailTestKey", of: mailTestKey },
      { name: "enrollKey", of: enrollKey },
      /*
       * The eleventh, and it arrived without being added here — which is the one
       * way this list can fail, since it covers a builder by holding it. Deleting
       * `PROVISION_NS` so a provisioning attempt composed as a bare address would
       * merge its counter into `addressKey`'s, and every other assertion in this
       * file stays green.
       */
      { name: "provisionKey", of: provisionKey },
      /*
       * The twelfth, and the first that counts a caller who is *signed in*. It
       * takes two arguments like `loginKey` and for the opposite reason: the
       * second half separates two routes rather than two identities, so it is fed
       * the same string twice here for the same collision-hunting reason.
       */
      { name: "writeKey", of: (value) => writeKey(value, value) },
    ];
    for (const argument of ["pwchg", "mail", "reset", "a|b", "x".repeat(300)]) {
      const produced = builders.map((builder) => builder.of(argument));
      report(
        `${builders.length} builders write ${builders.length} keys for ${JSON.stringify(argument.slice(0, 12))}`,
        new Set(produced).size === builders.length,
        `${new Set(produced).size} distinct of ${builders.length}`,
      );
    }
  }

  /*
   * The recipient keys, which are the two that follow the victim rather than the
   * caller — and the split between them is what stops a registration flood
   * closing somebody's only way back into their account.
   */
  check("mail is bounded per address, whatever case it was typed in", mailKey("A@B"), mailKey("a@b"));
  check("and reset mail is counted somewhere else entirely", mailKey("a@b") === resetMailKey("a@b"), false);

  /*
   * ⭐ **A long address must not fold into somebody else's counter**, which is the
   * whole reason `MAX_EMAIL_KEY_CHARS` exists — and it was unreachable.
   *
   * `field` calls `normalize` first, and `normalize` slices the value at
   * `MAX_KEY_CHARS`. At 200 that cut happened *before* the 254 ever applied, so
   * the second slice was a no-op and every address was truncated at 200 twice
   * over — once as a field, once again as the composed key. Two addresses sharing
   * their first 200 characters therefore shared one mail-bomb budget: flood the
   * first and the second cannot be sent a verification link.
   *
   * `address.ts` allows 254, so the pair below is legal input rather than a
   * contrived one, and it differs only past character 200.
   */
  {
    const stem = "a".repeat(240);
    const long = `${stem}1@example.com`;
    const alsoLong = `${stem}2@example.com`;
    check("two addresses differing past 200 characters are two counters", mailKey(long) === mailKey(alsoLong), false);
    check("and the same holds for the reset budget", resetMailKey(long) === resetMailKey(alsoLong), false);
    // The cap still exists — this is a bound, not its removal.
    report(
      "while a composed key is still bounded",
      mailKey(long).length <= 320,
      `${mailKey(long).length} chars`,
    );
  }

  /*
   * The write budget's own separation, which is the property that makes one key
   * usable for several routes: hammering one must not lock the others, and a
   * caller cannot reach across to another account's budget.
   */
  check("two routes on one account are two budgets", writeKey("u_1", "token") === writeKey("u_1", "enroll"), false);
  check("and two accounts on one route are two more", writeKey("u_1", "token") === writeKey("u_2", "token"), false);
}

/* ------------------------------------------------------------------ *
 * A password, as a function
 *
 * `password.ts` was imported by no driver either. Everything here is reachable
 * through `POST /v1/login`, and every one of these cases is one that route
 * cannot show you: which of two refusals fired, whether a stored row was
 * re-hashed, and whether a corrupt row refuses or throws.
 * ------------------------------------------------------------------ */

process.stdout.write("\na password, as a function\n");
{
  /* -- policy ---------------------------------------------------------- */

  // The one composition rule, and it is not a composition rule: it refuses the
  // single weak choice that actually gets made on a one-admin system.
  check("a password may not be the user name", checkPasswordPolicy("ada-lovelace", "ada-lovelace") === null, false);
  check("and case does not dodge that", checkPasswordPolicy("ADA-LOVELACE", "ada-lovelace") === null, false);
  check("nor does the surrounding space the name is compared without", checkPasswordPolicy("ada-lovelace", "  Ada-Lovelace  ") === null, false);
  check("a short one is refused", checkPasswordPolicy("short", "grace") === null, false);
  /*
   * The maximum is not about KDF cost — scrypt passes the input through one
   * iteration of PBKDF2-HMAC-SHA256, so length barely moves the curve — it is
   * about not normalizing and storing a string somebody else sized. Asserted at
   * the boundary in both directions, because a bound tested on one side is a
   * bound that can be off by one for ever.
   */
  check("the longest allowed is allowed", checkPasswordPolicy("x".repeat(PASSWORD_MAX_LENGTH), "grace"), null);
  check("and one more is not", checkPasswordPolicy("x".repeat(PASSWORD_MAX_LENGTH + 1), "grace") === null, false);
  check("a non-string is refused rather than coerced", checkPasswordPolicy(12345678901234, "grace"), "password must be a string");

  /* -- normalization ---------------------------------------------------- */

  /*
   * The same password typed on an iOS keyboard and on a laptop can be different
   * byte sequences for the same characters. NFKC is applied by one function at
   * set time and at verify time, so the two cannot drift — which is exactly what
   * this asserts by hashing one form and verifying the other.
   *
   * Written as escapes rather than as literal characters, because the two forms
   * are indistinguishable on screen and an editor that normalizes on save would
   * turn this case into two identical strings — passing, and measuring nothing.
   */
  // Annotated `string` rather than left to infer: as literal types these two are
  // provably distinct, so `tsc` calls the comparison below unintentional
  // (TS2367) and refuses to build \u2014 which would delete the one assertion that
  // catches an editor normalizing this file on save.
  const decomposed: string = "cafe\u0301-passphrase";
  const precomposed: string = "caf\u00e9-passphrase";
  check("the two spellings really are different bytes", decomposed === precomposed, false);
  check("and normalize to one", normalizePassword(decomposed), normalizePassword(precomposed));
  // Through the KDF and back, which is the claim that matters: normalization is
  // applied by the same function at set time and at verify time, so the two
  // cannot come apart.
  check("so a hash written from one verifies the other", (await verifyPassword(precomposed, await hashPassword(decomposed, "authenticated"), "authenticated")).ok, true);
  // Never `trim()`. `hashCredential` does, which is right for a token pasted out
  // of a terminal and catastrophic for a password whose last character is a
  // space — the route-level half of this is asserted in the section above.
  check("normalizing does not trim", normalizePassword("  spaced  "), "  spaced  ");

  /* -- a corrupt row is a refusal, never a throw ------------------------ */

  /*
   * `decode` is private, and deliberately: what a caller can observe is that
   * `verifyPassword` answers `{ok: false}` for a row this module did not write.
   * A throw here would be a 500 on the login path for one damaged row, on a
   * service where a 500 and a wrong password are the same screen.
   */
  const corrupt = [
    "",
    "not-a-hash",
    "scrypt$32768$8$1$onlyfiveparts",
    // N below the floor, and N above what `MAX_MEM` would let scrypt compute —
    // bounded in `decode` rather than at `scrypt`, which would throw.
    "scrypt$1$8$1$c2FsdA$ZGs",
    "scrypt$1048576$8$1$c2FsdA$ZGs",
    // Well-formed shape, empty salt and dk.
    "scrypt$32768$8$1$$",
    // Somebody else's format entirely.
    "$2b$12$abcdefghijklmnopqrstuv",
  ];
  const refusals: string[] = [];
  for (const stored of corrupt) {
    try {
      const verified = await verifyPassword("any-password-at-all", stored, "authenticated");
      refusals.push(verified.ok ? "accepted" : "refused");
    } catch (error) {
      refusals.push(`threw ${describeError(error)}`);
    }
  }
  check("every corrupt stored hash is a refusal", new Set(refusals).size === 1 && refusals[0] === "refused", true);

  /* -- raising N reaches an existing password ---------------------------- */

  /*
   * The format string *is* the migration mechanism: the parameters read back are
   * the ones the row was **written** with, never the ones this process prefers,
   * which is the difference between raising N re-hashing people gradually as
   * they sign in and raising N invalidating every password in the fleet at once.
   *
   * Written here by hand at N=2^14 because `hashPassword` only ever writes the
   * current parameters, so an old row is not otherwise reachable from a driver.
   * No `maxmem` is passed, and that is the measurement `password.ts` records
   * from the other side: 128·N·r at 2^14 is 16 MiB and fits under Node's 32 MiB
   * default, while 2^15 wants exactly 32 MiB and OpenSSL refuses at the boundary.
   */
  const legacyHash = (password: string): string => {
    const salt = randomBytes(16);
    const dk = scryptSync(normalizePassword(password), salt, 32, { N: 16384, r: 8, p: 1 });
    return ["scrypt", 16384, 8, 1, salt.toString("base64url"), dk.toString("base64url")].join("$");
  };
  const oldRow = legacyHash("an-old-stored-password");
  check("an older row still verifies", await verifyPassword("an-old-stored-password", oldRow, "authenticated"), {
    ok: true,
    needsRehash: true,
  });
  check("and a wrong password against it still does not", (await verifyPassword("not-that-one-at-all", oldRow, "authenticated")).ok, false);

  /*
   * And the half only the route can show: `needsRehash` is a flag nobody has to
   * act on, and the one thing that ever rewrites an existing row is
   * `POST /v1/login` doing it after a successful verification — because there is
   * nothing else anywhere that knows the plaintext. It is best-effort inside a
   * `try/catch`, so a regression here fails silently and for ever: everybody
   * keeps signing in, at the old parameters, with nothing on any screen.
   */
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const ancient = newId("u");
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'ancient', 0, ?)").run(ancient, now);
  db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(ancient, oldRow, now);
  const storedHash = (): string =>
    String(db.prepare("SELECT hash FROM user_passwords WHERE user_id = ?").get(ancient)?.["hash"] ?? "");
  const signIn = (): Promise<Response> =>
    Promise.resolve(
      app.request("/v1/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ancient", password: "an-old-stored-password" }),
      }),
    );

  check("a password stored at older parameters still signs in", (await signIn()).status, 200);
  const rewritten = storedHash();
  check("and the row is rewritten at the current ones", rewritten.startsWith(`scrypt$${CURRENT_PARAMS.N}$${CURRENT_PARAMS.r}$${CURRENT_PARAMS.p}$`), true);
  check("so it no longer asks to be", (await verifyPassword("an-old-stored-password", rewritten, "authenticated")).needsRehash, false);
  // The rewrite is the dangerous half: a re-hash of the wrong string, or of the
  // right string with the wrong salt, locks somebody out of an account they just
  // signed into successfully.
  check("and the same password still works against it", (await signIn()).status, 200);
}

/* ------------------------------------------------------------------ *
 * Guessing, throttling and the two lanes — through the routes
 *
 * The three cases here are all *concurrency*, which is why they are route-level
 * rather than unit-level: each one is about what happens between a synchronous
 * decision and the `await` that follows it, and neither half is visible from one
 * request at a time.
 *
 * Its own app per case, because a throttle is per instance — the sections above
 * would otherwise have already armed it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nguessing, under concurrency\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const adminKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_sentry', 'sentry', 1, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_sentry', ?, ?, ?)").run(
    newId("ak"),
    adminKey.prefix,
    adminKey.hash,
    now,
  );
  const admin = { authorization: `Bearer ${adminKey.key}`, "content-type": "application/json" };
  const on = (instance: ReturnType<typeof createControlPlaneApp>) => ({
    post: (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
      Promise.resolve(instance.request(path, { method: "POST", headers, body: JSON.stringify(body) })),
  });
  const root = on(app);
  const grace = (await (await root.post("/v1/admin/users", { name: "grace" }, admin)).json()) as {
    id: string;
    password: string;
  };
  const json = (headers: Record<string, string> = {}): Record<string, string> => ({
    "content-type": "application/json",
    ...headers,
  });

  /* -- what a signed-in caller may write --------------------------------- */

  {
    /*
     * **The first bound on an authenticated caller in this service.** Below THE
     * LINE there were three middlewares and no counter, so an ordinary account
     * could drive `POST /v1/tokens` — one Ed25519 signature — and
     * `POST /v1/machines/:id/enrollments` — a transaction under `PRAGMA
     * synchronous = FULL`, writing a row to a table with no sweeper — as fast as
     * it could ask, on the process that in embedded mode holds every tunnel in
     * the fleet.
     *
     * Driven through the route rather than as a key, because the defect this
     * guards against is *not being wired up*: every pure assertion about the key
     * builders passes whether or not a route calls one, which is the failure this
     * file's own `applyConfigChange` note records one package over.
     *
     * The machine name is deliberately one that does not exist. `spendWrite` runs
     * before the lookup, so the budget is spent by a request that then fails —
     * which is the point being asserted, since a guard placed after the expensive
     * part is not a guard.
     */
    const fresh = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < WRITE_THROTTLE.threshold + 2; attempt += 1) {
      statuses.push((await on(fresh).post("/v1/tokens", { machine: "no-such-machine" }, admin)).status);
    }
    report(
      "a signed-in account minting in a loop is eventually refused",
      statuses.slice(0, WRITE_THROTTLE.threshold).every((status) => status !== 429) && statuses.at(-1) === 429,
      `first ${WRITE_THROTTLE.threshold}: ${[...new Set(statuses.slice(0, WRITE_THROTTLE.threshold))].join("/")}, last: ${String(statuses.at(-1))}`,
    );

    /*
     * And the separation that makes one budget usable for two routes: the account
     * that just spent its token budget can still enroll a machine. Without the
     * `what` half of the key, a client polling tokens would lock its owner out of
     * the one act that gets a daemon onto the network.
     */
    const made = (await (await on(fresh).post("/v1/machines", { name: "throttle-probe" }, admin)).json()) as {
      machine?: { id: string };
      id?: string;
    };
    const machineId = made.machine?.id ?? made.id ?? "";
    const enrolled = await on(fresh).post(`/v1/machines/${machineId}/enrollments`, {}, admin);
    report(
      "while the same account can still mint an enrollment code",
      enrolled.status !== 429,
      `enrollments: ${enrolled.status}`,
    );
  }

  /* -- check-then-act ---------------------------------------------------- */

  {
    /*
     * **The regression test for the optimistic-fail fix, and it is the sharpest
     * measurement in this file.**
     *
     * `check` is synchronous and `fail` used to run only *after*
     * `await verifyPassword`, so every guess arriving inside one KDF window saw
     * a counter nothing had incremented yet. Measured before the fix: 40
     * concurrent guesses reached **36** real verifications against a documented
     * threshold of 5 — the throttle was measuring the semaphore rather than the
     * guesses. Recording before the await closes the window, and `succeed` is
     * what makes that free for somebody who gets it right.
     *
     * The number that reaches a 401 is therefore threshold + 1: the request that
     * trips the block passed `check` before its own `fail` set it.
     */
    const fresh = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const attempts = await Promise.all(
      Array.from({ length: 40 }, () =>
        on(fresh).post("/v1/login", { name: "grace", password: "definitely-not-it" }, json({ "x-forwarded-for": "198.51.100.9" })),
      ),
    );
    const verified = attempts.filter((response) => response.status === 401).length;
    const throttled = attempts.filter((response) => response.status === 429).length;
    report(
      "concurrent guesses are counted against the threshold, not the semaphore",
      verified <= DEFAULT_THROTTLE.threshold + 1,
      `${verified} reached the KDF (was 36), ${throttled} refused`,
    );
    check("and every one of the forty was answered", verified + throttled, 40);
    // The refusal has to be actionable or a client retries straight into it.
    const blocked = attempts.find((response) => response.status === 429);
    check("the refusal carries a code and a wait", [
      ((await blocked?.clone().json()) as { error?: { code?: string } } | undefined)?.error?.code ?? "none",
      Number(blocked?.headers.get("retry-after") ?? 0) > 0,
    ], ["too_many_attempts", true]);
  }

  /* -- check-then-act, one table over ------------------------------------- */

  {
    /*
     * **The same window, on a route that is not about guessing at all.**
     * `POST /v1/admin/users` reads `SELECT id FROM users WHERE name = ?` and
     * then awaits ~51ms of scrypt before its INSERT, so two overlapping creates
     * of one name both pass the read and the second trips `users.name UNIQUE`.
     * Rethrown, it reached Hono's default handler and answered `500 text/plain`
     * — a body with **no `error.code`**, which is the one shape every client in
     * this system is written against — from the exact request that answers
     * `409 user_exists` when it is run a second later. Two admins, two tabs, or
     * a provisioning script retrying is all it takes.
     *
     * The status alone is not the assertion: what a client can act on is the
     * envelope, so the content type and the code are read rather than assumed.
     */
    const envelopeCode = async (response: Response | undefined): Promise<string> => {
      if (response === undefined) return "(no response)";
      const text = await response.clone().text();
      try {
        return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "(no error key)";
      } catch {
        // Not JSON at all, which is precisely the defect rather than an
        // inconvenience — so it is reported with its body rather than as a
        // missing field.
        return `not json: ${text.slice(0, 40)}`;
      }
    };
    const passwordRows = (): number =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM user_passwords").get()?.["n"] ?? -1);

    const held = passwordRows();
    const both = await Promise.all([
      root.post("/v1/admin/users", { name: "clarke" }, admin),
      root.post("/v1/admin/users", { name: "clarke" }, admin),
    ]);
    check("one of two concurrent creates of one name wins", both.map((r) => r.status).sort().join(","), "201,409");
    const loser = both.find((response) => response.status !== 201);
    check("and the loser answers in the envelope every client parses", [
      loser?.headers.get("content-type")?.split(";")[0] ?? "(none)",
      await envelopeCode(loser),
    ], ["application/json", "user_exists"]);
    check("with exactly one user and one password row behind it", [
      Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'clarke'").get()?.["n"] ?? -1),
      // A delta rather than a total, because every other section in this file
      // writes to that table too.
      passwordRows() - held,
    ], [1, 1]);
    /*
     * And the connection is still usable, which is what the `ROLLBACK` in front
     * of the 409 is actually for. The loser throws on the *first* statement
     * inside its transaction, so there was never anything partial to undo — what
     * an un-rolled-back `BEGIN` takes out is the *next* writer, with "cannot
     * start a transaction within a transaction", on a request that did nothing
     * wrong and against a connection every other writer in this process shares.
     */
    check("and the next create is unaffected", (await root.post("/v1/admin/users", { name: "sagan" }, admin)).status, 201);
  }

  /* -- the lockout, which is the defect this key composition exists for --- */

  {
    /*
     * **The confirmed defect, asserted so it cannot come back.** Eleven
     * unauthenticated `POST /v1/login` requests naming `grace` from one address
     * must not stop grace doing anything at all — and keyed on the bare name
     * they stopped her signing in *with the correct password* and stopped her
     * password change on a valid session. Sustaining it cost about eleven
     * requests every fifteen minutes, from anywhere, with no credential.
     */
    // Proxied, so the driver can stand in for the hop that writes the address —
    // see the block header where this app's twin is built. Distinct addresses are
    // the whole subject here, and with the header ignored there is only one.
    const fresh = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      trustedProxyHops: 1,
    });
    const attacker = "198.51.100.66";
    for (let i = 0; i < 11; i += 1) {
      await on(fresh).post("/v1/login", { name: "grace", password: "nope-nope-nope" }, json({ "x-forwarded-for": attacker }));
    }
    check("the sprayed address is blocked", (await on(fresh).post("/v1/login", { name: "grace", password: grace.password }, json({ "x-forwarded-for": attacker }))).status, 429);
    const elsewhere = await on(fresh).post("/v1/login", { name: "grace", password: grace.password }, json({ "x-forwarded-for": "203.0.113.42" }));
    check("but she still signs in from her own", elsewhere.status, 200);
    const session = (await elsewhere.json()) as { token: string };
    /*
     * And from *inside* the spray, because the remedy must not be blocked by the
     * attack it is the remedy for: `passwordChangeKey` is namespaced on the user
     * id, which nothing anonymous can write and nobody else can type.
     */
    const changed = await on(fresh).post(
      "/v1/me/password",
      { currentPassword: grace.password, newPassword: "a-brand-new-password" },
      json({ authorization: `Bearer ${session.token}`, "x-forwarded-for": attacker }),
    );
    check("and changes her password while it is still happening", changed.status, 200);
  }

  /* -- and with no proxy configured, the header decides nothing ------------ */

  {
    /*
     * **The other half of the same key, and the reason the setting exists.**
     *
     * The block above simulates a proxied instance, where `x-forwarded-for` is
     * written by a hop the operator controls and is therefore a fact. The default
     * is that no such hop exists — and there the header is a string the *caller*
     * typed. Read unconditionally, as it used to be, it handed everyone their own
     * rate-limit bucket: rotate it per request and the login counter and the
     * per-address backstop are both defeated, however low the threshold is set.
     *
     * Driven rather than argued, because the pure assertions on `callerAddressOf`
     * would pass with the route reading the header some other way: forty sign-in
     * attempts each claiming a different address must still meet the counter that
     * an unproxied instance keys on the socket they all really share.
     */
    const unproxied = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      const answer = await on(unproxied).post(
        "/v1/login",
        { name: "grace", password: "still-not-it" },
        json({ "x-forwarded-for": `198.51.100.${i}` }),
      );
      if (answer.status === 429) refused += 1;
    }
    report(
      "rotating the forwarded header does not buy a fresh bucket",
      refused > 0,
      `${refused} of 40 were refused despite 40 distinct claimed addresses`,
    );
  }

  /* -- the lane gate ------------------------------------------------------ */

  {
    /*
     * **One gate was a starvation weapon.** The login route reaches the KDF on
     * every request by design — an unknown name verifies against the decoy so
     * the timing says nothing — so a spray of *distinct* names is a spray of
     * real hashes, and no per-identity threshold ever sees it. Measured before
     * the split: 36 hashes in flight, and every login *and* every admin password
     * reset answered `503 overloaded`.
     *
     * Distinct names **and** distinct addresses, because both counters have to
     * be missed for the spray to reach the KDF at all — which is itself the
     * shape of the attack this lane split is the second half of.
     */
    const fresh = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const spray = Array.from({ length: 40 }, (_, i) =>
      on(fresh).post(
        "/v1/login",
        { name: `ghost-${i}`, password: "not-a-password-either" },
        json({ "x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i % 250}` }),
      ),
    );
    /*
     * Launched *after* the spray and awaited with it, so it is genuinely
     * competing rather than following. This is the authenticated lane.
     *
     * **`POST /v1/me/password`, and the choice of route is the assertion.** This
     * used to be `POST /v1/admin/users/:id/password`, which is deleted. The
     * obvious repoint is `POST /v1/me/keys` — and it would be **wrong in a way
     * that goes green**: a key is `newApiKey` → `hashCredential` → sha256, which
     * takes no lane slot at all, so the check would pass while proving nothing
     * about the semaphore it exists to measure. This route runs
     * `hashPassword(next, "authenticated")` and is the only self-service one
     * that does.
     */
    const reset = root.post(
      "/v1/me/password",
      { newPassword: "a-perfectly-fine-new-password" },
      admin,
    );
    const sprayed = await Promise.all(spray);
    const overloaded = sprayed.filter((response) => response.status === 503);
    report(
      "a public spray is refused rather than queued without bound",
      overloaded.length > 0,
      `${overloaded.length} of ${sprayed.length} answered 503`,
    );
    check("with the code and the header that make it a refusal that expires", [
      ((await overloaded[0]?.clone().json()) as { error?: { code?: string } } | undefined)?.error?.code ?? "none",
      overloaded[0]?.headers.get("retry-after") ?? null,
    ], ["overloaded", "1"]);
    // The whole point of two of four rather than one gate of four: the remedy
    // for a flood stays reachable *during* the flood.
    check("and an authenticated hash still completes through it", (await reset).status, 200);
  }
}

/* ------------------------------------------------------------------ *
 * A session's two expiries, its cap, and the write that is skipped
 *
 * `resolveSession`'s refusal arms had no coverage on this side at all, which is
 * the sharpest asymmetry the file had: `webcheck` already asserts that the
 * browser signs out on `401 session_expired`, against a code nothing here proved
 * the server could ever send.
 *
 * Driven with explicit `now` values against `sessions.ts` directly, and then once
 * through the route — the unit half reaches the arms, the route half proves the
 * arms have a wire code.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsessions: expiry, the cap, and last_seen\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
  const bearer = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];
  const anonymous = { ip: null, userAgent: null };

  const sleeper = newId("u");
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'sleeper', 0, ?)").run(sleeper, now);

  /* -- the two arms ------------------------------------------------------ */

  const T0 = Date.now();
  /*
   * Asked by id rather than by counting the list, because this user holds
   * several sessions by the end of the section and "the list is empty" would be
   * a different claim that happens to be true at one point in the sequence.
   */
  const listedAt = (userId: string, sessionId: string, at: number): boolean =>
    listSessions(db, userId, at).some((row) => row.id === sessionId);
  {
    const absolute = mintSession(db, sleeper, anonymous, T0);
    // `last_seen_at` moved forward so the idle arm cannot fire first and the
    // absolute one is what is being read. Both answer `expired`, and they are
    // separately reachable — which is why both are driven rather than one.
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?").run(T0 + SESSION_TTL_MS, absolute.id);
    check("a session resolves while it is live", resolveSession(db, absolute.token, T0), {
      ok: true,
      session: { id: absolute.id, userId: sleeper },
    });
    check("and is expired past its absolute TTL", resolveSession(db, absolute.token, T0 + SESSION_TTL_MS + 1), {
      ok: false,
      reason: "expired",
    });
    check("the listing drops it too", [listedAt(sleeper, absolute.id, T0), listedAt(sleeper, absolute.id, T0 + SESSION_TTL_MS + 1)], [true, false]);
  }
  {
    const idle = mintSession(db, sleeper, anonymous, T0);
    /*
     * The idle arm alone: still inside the thirty days, unused for more than the
     * fourteen. This is the one the SQL cannot answer — `listSessions` filters
     * `expires_at > now` in the query and the idle window in JavaScript, so a
     * driver that only asked the database would report this session as live.
     */
    check("and expired again for sitting unused", resolveSession(db, idle.token, T0 + SESSION_IDLE_MS + 1), {
      ok: false,
      reason: "expired",
    });
    check("which the listing also drops", [listedAt(sleeper, idle.id, T0), listedAt(sleeper, idle.id, T0 + SESSION_IDLE_MS + 1)], [true, false]);
    report(
      "the idle window really is the shorter of the two",
      SESSION_IDLE_MS < SESSION_TTL_MS,
      `${SESSION_IDLE_MS / 86_400_000}d idle, ${SESSION_TTL_MS / 86_400_000}d absolute`,
    );
  }

  /*
   * **The code `webcheck` already asserts the client acts on, proven reachable.**
   * Both arms are driven through `callerAuth`, because they are one refusal on
   * the wire and a client that signed out on only one of them would leave a
   * fourteen-day-old tab in a loop it cannot explain.
   */
  {
    const stale = mintSession(db, sleeper, anonymous);
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, stale.id);
    check("an expired session is a 401 the client can act on", await outcome(await send("/v1/me", { headers: bearer(stale.token) })), [401, "session_expired"]);
  }
  {
    const forgotten = mintSession(db, sleeper, anonymous);
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?").run(Date.now() - SESSION_IDLE_MS - 1, forgotten.id);
    check("and so is one nobody has used for a fortnight", await outcome(await send("/v1/me", { headers: bearer(forgotten.token) })), [401, "session_expired"]);
  }
  // Distinct from `invalid_api_key` on purpose, and safe to distinguish: reaching
  // either required presenting a real 256-bit token.
  check("a token this service never minted is not either of those", await outcome(await send("/v1/me", { headers: bearer("rs_" + "x".repeat(43)) })), [401, "invalid_api_key"]);

  /* -- the cap, and which end of it goes -------------------------------- */

  {
    const crowded = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'crowded', 0, ?)").run(crowded, now);
    // Distinct `now` per mint, so `ORDER BY created_at DESC` has no ties to
    // resolve — the direction being asserted is the whole point and a tie would
    // make it luck.
    const tokens = Array.from({ length: MAX_SESSIONS_PER_USER + 2 }, (_, i) => mintSession(db, crowded, anonymous, T0 + i));
    const live = Number(
      db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL").get(crowded)?.["n"] ?? 0,
    );
    check("exactly the cap survives", live, MAX_SESSIONS_PER_USER);
    check("and the listing agrees", listSessions(db, crowded, T0 + MAX_SESSIONS_PER_USER + 2).length, MAX_SESSIONS_PER_USER);
    /*
     * **The oldest go, and the direction is the decision.** Being unable to sign
     * in on a new device because of an old one is the wrong failure — the phone
     * in your hand is the one you are asking about.
     */
    check("the two oldest are the ones retired", [
      resolveSession(db, tokens[0]?.token ?? "", T0).ok,
      resolveSession(db, tokens[1]?.token ?? "", T0).ok,
      resolveSession(db, tokens[2]?.token ?? "", T0).ok,
    ], [false, false, true]);
    check("and the newest still reaches /v1/me", (await send("/v1/me", { headers: bearer(tokens[tokens.length - 1]?.token ?? "") })).status, 200);
  }

  /* -- last_seen_at, written at most once a quarter of an hour ----------- */

  {
    /*
     * The guard that makes idle expiry affordable at all: without it this is an
     * `UPDATE` on the authentication path of the process that carries every
     * relay tunnel, against a database running `synchronous = FULL` — an fsync
     * per request, to record something nothing authenticates against.
     */
    const touched = mintSession(db, sleeper, anonymous, T0);
    const lastSeen = (): number =>
      Number(db.prepare("SELECT last_seen_at FROM user_sessions WHERE id = ?").get(touched.id)?.["last_seen_at"] ?? -1);
    check("a session starts marked as seen now", lastSeen(), T0);
    touchSession(db, touched.id, T0 + 1_000);
    check("a request a second later writes nothing", lastSeen(), T0);
    touchSession(db, touched.id, T0 + LAST_SEEN_WRITE_INTERVAL_MS);
    check("nor does one exactly at the interval", lastSeen(), T0);
    touchSession(db, touched.id, T0 + LAST_SEEN_WRITE_INTERVAL_MS + 1);
    check("and one past it does", lastSeen(), T0 + LAST_SEEN_WRITE_INTERVAL_MS + 1);
  }

  /* -- signing out, and the field name that had to change ---------------- */

  {
    const holder = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'holder', 0, ?)").run(holder, now);
    const first = mintSession(db, holder, anonymous);
    const second = mintSession(db, holder, anonymous);
    const third = mintSession(db, holder, anonymous);

    const one = (await (await send(`/v1/me/sessions/${second.id}`, { method: "DELETE", headers: bearer(first.token) })).json()) as Record<string, unknown>;
    check("signing one device out answers a boolean", one, { revoked: true });
    const current = (await (await send("/v1/me/sessions/current", { method: "DELETE", headers: bearer(third.token) })).json()) as Record<string, unknown>;
    check("and so does signing this one out", current, { revoked: true });

    /*
     * **`revokedCount`, not `revoked`.** Three routes shared one field name and
     * two types: a client reading `body.revoked` as the outcome saw `true` for
     * one session and `0` — falsy, i.e. "it failed" — for the honest answer that
     * there was nothing left to sign out of. The count was renamed rather than
     * the booleans, because a boolean called `revoked` is what the other two mean.
     */
    const all = (await (await send("/v1/me/sessions", { method: "DELETE", headers: bearer(first.token) })).json()) as Record<string, unknown>;
    check("signing out everywhere answers a count", all, { revokedCount: 1 });
    check("and does not also answer under the boolean's name", "revoked" in all, false);
  }
}

/* ------------------------------------------------------------------ *
 * What a machine may be called, and what revoking one gives back
 *
 * `machines.ts` was imported by no driver. Three of the rules in it were written
 * *because* of a defect and none of them was asserted anywhere: the reserved
 * label shape, the per-owner quota, and `releaseOwner`.
 * ------------------------------------------------------------------ */

process.stdout.write("\nmachines somebody owns\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
  const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
    send(path, { method: "POST", headers, body: JSON.stringify(body) });
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];
  const message = async (response: Response): Promise<string> =>
    ((await response.json()) as { error?: { message?: string } }).error?.message ?? "";

  /*
   * A credential by SQL rather than by `POST /v1/admin/users`, which costs a
   * scrypt hash each. Nothing in this section is about passwords, and this file
   * already spends about forty of them one section up.
   */
  const withKey = (name: string, isAdmin = false): { id: string; headers: Record<string, string> } => {
    const id = newId("u");
    const key = newApiKey();
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)").run(id, name, isAdmin ? 1 : 0, now);
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      id,
      key.prefix,
      key.hash,
      now,
    );
    return { id, headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" } };
  };

  const admin = withKey("fleetadmin", true);
  const lovelace = withKey("lovelace");

  /* -- the label rules, as a function and through the route -------------- */

  check("an ordinary name is well formed", labelIsWellFormed("laptop"), true);
  check("an empty one is not", labelIsWellFormed(""), false);
  check("nor is one with a space in it", labelIsWellFormed("my laptop"), false);
  check("nor one that starts with punctuation", labelIsWellFormed("-laptop"), false);
  check("nor one past sixty-four characters", labelIsWellFormed("a".repeat(65)), false);
  /*
   * **The reserved shape, which is a real collision rather than tidiness.**
   * `MACHINE_LABEL` allows every character `newId("m")` produces, so a label
   * could be spelled exactly like somebody else's machine id — and
   * `POST /v1/tokens {machine: "m_1a2b3c4d"}` then minted a token whose `aud` is
   * *your* machine while the client believed it had asked for the other one.
   *
   * Asserted against ids this driver actually generates, because the regex has
   * to refuse the shape the minter really has and not the shape somebody
   * remembered it having.
   */
  check("a label spelled like a machine id is refused", labelIsWellFormed("m_1a2b3c4d"), false);
  // The pre-widening width, which every id already in a database still has. A
  // pattern tracking only the current one would leave the oldest machines in the
  // fleet the only ones whose ids are spellable as somebody else's label.
  check("including the width ids used to have", labelIsWellFormed("m_1a2b3c4d5e6f7a8b"), false);
  check("while a near miss stays an ordinary name", labelIsWellFormed("m_1a2b3c4d5e6f7a8"), true);
  report(
    "and the reserved shape is exactly what newId mints",
    Array.from({ length: 200 }, () => newId("m")).every((id) => MACHINE_LABEL_RESERVED.test(id)),
    "200 generated ids, all matched",
  );
  // Anchored and exact-length, so it refuses only the shape an id actually has.
  check("a longer hex tail stays an ordinary name", labelIsWellFormed("m_deadbeefcafe"), true);
  check("and a shorter one does too", labelIsWellFormed("m_1a2b3c4"), true);

  check("a name with a slash is refused", await outcome(await post("/v1/machines", { name: "ada/laptop" }, lovelace.headers)), [400, "bad_request"]);
  check("a name that is only space is refused", await outcome(await post("/v1/machines", { name: "   " }, lovelace.headers)), [400, "bad_request"]);
  check("an over-long name is refused", await outcome(await post("/v1/machines", { name: "a".repeat(65) }, lovelace.headers)), [400, "bad_request"]);
  check("and one shaped like a machine id is too", await outcome(await post("/v1/machines", { name: "m_deadbeef" }, lovelace.headers)), [400, "bad_request"]);
  /*
   * The two refusals say different things, and that is the point of
   * `MACHINE_LABEL_RESERVED_HELP` existing at all: a label spelled like an id
   * passes the character rule by construction, so "letters, digits, and . _ -"
   * would be a refusal describing a rule the caller did not break.
   */
  check("and says which rule it broke", await message(await post("/v1/machines", { name: "m_deadbeef" }, lovelace.headers)), MACHINE_LABEL_RESERVED_HELP);
  check("where a malformed one gets the other sentence", await message(await post("/v1/machines", { name: "ada/laptop" }, lovelace.headers)), MACHINE_LABEL_HELP);
  /*
   * Surrounding space is **trimmed rather than refused**, and that is
   * `readLabel`'s documented contract — "the caller trims before calling". So
   * what is asserted is the stored value, since the alternative reading (a 400)
   * and this one are indistinguishable from the outside until somebody looks at
   * the row.
   */
  const spaced = (await (await post("/v1/machines", { name: "  spaced  " }, lovelace.headers)).json()) as {
    machine: { id: string; name: string };
  };
  check("surrounding space is trimmed off a label", spaced.machine.name, "spaced");
  check("and that is what is stored", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(spaced.machine.id)?.["label"], "spaced");

  /* -- renaming ---------------------------------------------------------- */

  {
    const box = (await (await post("/v1/machines", { name: "workbench" }, lovelace.headers)).json()) as {
      machine: { id: string };
    };
    const storedName = (): string =>
      String(db.prepare("SELECT name FROM machines WHERE id = ?").get(box.machine.id)?.["name"] ?? "");
    const before = storedName();
    const renamed = await send(`/v1/machines/${box.machine.id}`, {
      method: "PATCH",
      headers: lovelace.headers,
      body: JSON.stringify({ name: "bench" }),
    });
    check("a machine you own can be renamed", (await renamed.json()) as unknown, { id: box.machine.id, name: "bench", owned: true });
    /*
     * **`machines.name` is untouched, and that is the `qualifiedName`
     * invariant.** That column is globally `UNIQUE` and cannot stop being —
     * `migrate()` adds columns and never alters one — so the pretty name lives in
     * `machine_owners.label` where a collision is with your own machine and
     * leaks nothing. A rename that touched the row's real name would be a 409
     * telling one user that *another* user has a machine called "bench".
     */
    check("and the row's own name does not move", storedName(), before);
    report("which is still the qualified one", before.startsWith("workbench-"), before);

    // Through the route the wider `nameVisibleTo` refuses first, because you can
    // see both machines. It is the `409` a person meets.
    check("renaming onto a name you can already see is a 409", await outcome(await send(`/v1/machines/${box.machine.id}`, { method: "PATCH", headers: lovelace.headers, body: JSON.stringify({ name: "spaced" }) })), [409, "machine_exists"]);
    /*
     * And the unique index underneath it, reached directly — the route can only
     * get here when `nameVisibleTo` misses, which it does for a machine somebody
     * holds no grant on. `relabelMachine` carries `user_id` in its own `WHERE`
     * clause so the statement is safe read on its own rather than only in the
     * light of the route two statements above it.
     */
    check("and the index underneath says the same thing", relabelMachine(db, box.machine.id, lovelace.id, "spaced"), { error: "label_taken" });
    check("but a free label lands", relabelMachine(db, box.machine.id, lovelace.id, "bench-two"), null);
    // The clause, asserted: called with somebody else's id it changes nothing
    // rather than renaming a stranger's machine.
    relabelMachine(db, box.machine.id, admin.id, "stolen");
    check("a caller who is not the owner renames nothing", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(box.machine.id)?.["label"], "bench-two");
  }

  /* -- the quota, and what revoking gives back --------------------------- */

  {
    /*
     * **Both halves of `releaseOwner` in one sequence, because the docblock
     * argues them together and either alone was a permanent leak.**
     * `machine_owners` has no `revoked_at` and the unique index on
     * `(user_id, label)` does not join `machines`, so before this a revoked
     * machine kept its label *and* its quota slot for ever: revoke `spare`,
     * create `spare` again, and the answer was a 409 naming a machine that
     * appears in no list and can never be reached — and fifty revocations left
     * the account unable to add a machine at all, with nothing on screen to
     * explain it.
     *
     * Filled to one below the cap by SQL rather than by fifty requests: the
     * count `createOwnedMachine` reads is `machine_owners`, so that is the row
     * this has to be honest about and nothing else in the sequence looks at the
     * `machines` table for those.
     */
    const capped = withKey("capped");
    for (let i = 0; i < MAX_MACHINES_PER_USER - 1; i += 1) {
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        newId("m"),
        capped.id,
        `slot-${i}`,
        now,
      );
    }
    const owned = (): number =>
      Number(db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?").get(capped.id)?.["n"] ?? 0);

    const spare = (await (await post("/v1/machines", { name: "spare" }, capped.headers)).json()) as {
      machine: { id: string };
    };
    check("the last slot is usable", owned(), MAX_MACHINES_PER_USER);
    check("and the next machine is refused by the cap", await outcome(await post("/v1/machines", { name: "one-too-many" }, capped.headers)), [409, "machine_limit"]);

    const revoked = (await (await post(`/v1/machines/${spare.machine.id}/revoke`, {}, capped.headers)).json()) as {
      revoked: boolean;
      enrollmentCodesInvalidated: number;
    };
    // Creating a machine mints a code in the same request, so revoking it burns
    // exactly that one — a code is a full machine identity until it is redeemed.
    check("revoking reports what it burned", [revoked.revoked, revoked.enrollmentCodesInvalidated], [true, 1]);
    check("the quota slot comes back", owned(), MAX_MACHINES_PER_USER - 1);
    check("and so does the label", (await post("/v1/machines", { name: "spare" }, capped.headers)).status, 201);
    check("a second revoke of the same machine is a 404", await outcome(await post(`/v1/machines/${spare.machine.id}/revoke`, {}, capped.headers)), [404, "machine_not_found"]);
  }

  /* -- the configurable limit, and which machine it switches off ---------- */

  {
    /*
     * **The commercial bound, which is a different bound from the cap above.**
     *
     * Everything here is about `quota.ts` deriving "over the limit" from a
     * machine's *rank* among its owner's, rather than storing a suspended flag —
     * so the assertions that matter are the ones a stored-flag implementation
     * would fail while passing every other test in this file.
     *
     * Rows are inserted by SQL with chosen `created_at` values, because the
     * whole subject is an ordering and `Date.now()` cannot be asked for three
     * distinguishable instants on demand.
     */
    const limited = withKey("limited");
    const own = (label: string, createdAt: number): string => {
      const id = newId("m");
      db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
        id,
        `${label}-${id}`,
        createdAt,
        createdAt,
      );
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        limited.id,
        label,
        createdAt,
      );
      db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
        limited.id,
        id,
        "session:read session:write",
        createdAt,
      );
      return id;
    };
    /*
     * Deliberately inserted 3, 1, 2 rather than in `created_at` order, so an
     * implementation that ordered by rowid, by insertion, by id or by label
     * would agree with a naive fixture and disagree with this one.
     */
    const third = own("third", now + 300);
    const first = own("first", now + 100);
    const second = own("second", now + 200);

    const overOf = (): string[] =>
      [...overLimitMachineIds(db)].filter((id) => [first, second, third].includes(id)).sort();
    const setLimit = (n: number): void => writeMachineLimit(db, limited.id, n, "u_admin");

    setLimit(2);
    check("with a limit of two, the newest acquisition is the one that is over", overOf(), [third].sort());
    check("and it is the *acquisition* order, not the insertion order", machineStanding(db, first)?.rank, 0);
    check("nor the id order", machineStanding(db, third)?.rank, 2);

    /*
     * ⭐ **The whole derived-limit claim, and the assertion a stored flag
     * fails.** Nothing is written to any machine here — only the limit moves —
     * and the machine comes back by itself.
     */
    setLimit(3);
    check("raising the limit un-suspends, with no other act", overOf(), []);
    setLimit(1);
    check("and lowering it again takes the newest two", overOf(), [second, third].sort());

    /*
     * ⭐ **Revoking promotes the rest**, which is `releaseOwner` and the rank
     * interacting — no code in either file arranges it.
     */
    setLimit(2);
    check("with a limit of two again, only the newest is over", overOf(), [third].sort());

    /*
     * ⭐ **The routes, and not only the functions.** Everything above calls
     * `overLimitMachineIds` and `machineStanding` directly, which proves the rule
     * and nothing about the four places that enforce it. These are the two that
     * reach a person: the listing they read it from, and the token mint that is
     * the first thing to fail.
     */
    {
      const rows = (
        (await (await send("/v1/machines", { headers: limited.headers })).json()) as {
          machines: { id: string; overLimit: boolean; ownerDisabled: boolean }[];
        }
      ).machines;
      /*
       * **Listed rather than filtered out**, which is the decision the route's own
       * docblock makes: hiding one leaves somebody holding a machine they can
       * neither see nor retire, and retiring is the remedy that frees the slot.
       */
      check("the listing draws the suspended machine and says which", rows.filter((row) => row.overLimit).map((row) => row.id), [third]);
      check("and claims no ban while there is none", rows.every((row) => row.ownerDisabled === false), true);
    }

    /*
     * ⭐ **`POST /v1/tokens` refuses, and the *ordering* is the half that is a
     * security property rather than a message.**
     *
     * The refusal itself matters because this is the one place a sentence reaches
     * the person at the moment they ask — the tunnel is already refused at dial,
     * so a client handed a good token would draw "your machine is asleep" and send
     * somebody to restart a daemon that is running perfectly.
     *
     * The ordering matters more. Quota is evaluated **after** the grant is proved
     * so that a caller with no grant still meets the shared 404 that "no such
     * machine" answers; moved above it, any valid token becomes a probe for
     * whether an arbitrary `aud` exists and is over somebody's limit. The relay
     * half of this pair is asserted much further up; this route's identical
     * ordering was pinned by nothing.
     */
    check(
      "minting a token for a machine over its owner's limit is refused",
      await outcome(await post("/v1/tokens", { machine: third }, limited.headers)),
      [403, "machine_over_limit"],
    );
    {
      const stranger = withKey("tokenstranger");
      check(
        "and a caller with no grant still meets the shared 404, never a policy 403",
        await outcome(await post("/v1/tokens", { machine: third }, stranger.headers)),
        [404, "machine_not_found"],
      );
    }

    /*
     * ⭐ **A code minted here would redeem perfectly and produce a daemon nothing
     * can reach** — the "enrolled and nobody can see it" failure arriving through
     * a new door, which is why this refusal exists at all. Only the owner reaches
     * this route, so the sentence can name the remedy.
     */
    check(
      "minting an enrollment code for a suspended machine is refused",
      await outcome(await post(`/v1/machines/${third}/enrollments`, {}, limited.headers)),
      [403, "machine_over_limit"],
    );
    setLimit(3);
    check(
      "and raising the limit mints one again, nothing else touched",
      (await post(`/v1/machines/${third}/enrollments`, {}, limited.headers)).status,
      201,
    );
    setLimit(2);

    await post(`/v1/machines/${first}/revoke`, {}, limited.headers);
    check("revoking the oldest promotes the one that was over", overOf(), []);

    /*
     * ⭐ **The owner's ban, which is the *other* gate on the same row and which
     * only a grantee can ever observe** — a banned owner cannot get past
     * `callerAuth` to ask anything at all, so every assertion here is made from
     * somebody else's account. That is exactly the case that used to be invisible:
     * banning a person stopped them signing in and left every machine they owned
     * working for everyone holding a grant.
     *
     * Self-contained — its own user, machine and grantee — because it bans an
     * account, and doing that to `limited` would silently change every assertion
     * after it.
     *
     * `ownerDisabled` and `overLimit` are asserted as a **pair**, because the two
     * sets are built by two adjacent queries in the same route and wiring one to
     * the other is a one-word mistake that no single-field assertion notices.
     */
    {
      const owner = withKey("bannedowner");
      const grantee = withKey("banneegrantee");
      const machineId = newId("m");
      db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        `banned-${machineId}`,
        now,
        now,
      );
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        owner.id,
        "theirs",
        now,
      );
      for (const who of [owner.id, grantee.id]) {
        db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
          who,
          machineId,
          "session:read session:write",
          now,
        );
      }

      check(
        "before the ban the grantee mints a token normally",
        (await post("/v1/tokens", { machine: machineId }, grantee.headers)).status,
        200,
      );

      db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, owner.id);
      const row = (
        (await (await send("/v1/machines", { headers: grantee.headers })).json()) as {
          machines: { id: string; overLimit: boolean; ownerDisabled: boolean }[];
        }
      ).machines.find((candidate) => candidate.id === machineId);
      check("a grantee sees the owner's ban on the row, and not a limit", [row?.ownerDisabled, row?.overLimit], [true, false]);

      /*
       * ⭐ **`owner_disabled`, and emphatically not `user_disabled`.** The client
       * ends a session on the latter — correctly, it means *you* are banned — so
       * reusing it here would sign a perfectly good grantee out of the whole app
       * for opening somebody else's suspended machine.
       */
      check(
        "and is told the owner is banned, never that they are",
        await outcome(await post("/v1/tokens", { machine: machineId }, grantee.headers)),
        [403, "owner_disabled"],
      );

      /* Reversible, which is the entire reason a ban derives rather than revokes. */
      db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(owner.id);
      check(
        "un-banning brings it back with nobody touching a host",
        (await post("/v1/tokens", { machine: machineId }, grantee.headers)).status,
        200,
      );
    }

    /* -- ties on created_at, which decide the bound by one machine ---------- */

    {
      /*
       * ⭐ `created_at` is `Date.now()`, so two machines acquired in the same
       * millisecond are reachable from a script. Drop the `machine_id` half of
       * the row-value comparison and both rows count zero older siblings, both
       * report rank 0, and this account keeps two working machines under a limit
       * of one — the bound wrong by one, silently.
       */
      const tied = withKey("tied");
      const ids = ["m_tie_aaaa", "m_tie_bbbb"];
      for (const id of ids) {
        db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
          id,
          tied.id,
          id.slice(-4),
          now + 900,
        );
      }
      writeMachineLimit(db, tied.id, 1, "u_admin");
      const over = () => [...overLimitMachineIds(db)].filter((id) => ids.includes(id));
      check("two machines acquired in the same millisecond still rank apart", over().length, 1);
      check("and the same one, asked twice", over(), over());
      check("the tiebreak is the machine id, so the higher one goes", over(), ["m_tie_bbbb"]);
    }

    /* -- the instance default, and what unset means ------------------------ */

    {
      /*
       * ⭐ **The upgrade-safety assertion.** Nothing seeds `instance_settings`,
       * so this setting is unset on every existing deployment. If unset resolved
       * to 0 the next deploy would take every machine in the fleet off the
       * network with no operator having acted — and nothing else in this file
       * would fail.
       */
      const variable = envNameFor("machines.per_user");
      const held = process.env[variable];
      delete process.env[variable];
      clearSetting(db, "machines.per_user");
      check("unset is the behaviour before this setting existed", instanceMachineLimit(db), MAX_MACHINES_PER_USER);

      writeSetting(db, "machines.per_user", "2", "u_admin");
      check("a row is the instance default", instanceMachineLimit(db), 2);
      // An override beats it, and clearing the override hands it back.
      const defaulted = withKey("defaulted");
      check("with no override, a person gets the instance default", effectiveLimit(db, defaulted.id), {
        limit: 2,
        source: "default",
        instanceDefault: 2,
      });
      writeMachineLimit(db, defaulted.id, 5, "u_admin");
      check("their own row beats it", effectiveLimit(db, defaulted.id).limit, 5);
      clearMachineLimit(db, defaulted.id);
      check("and clearing it hands the instance default back", effectiveLimit(db, defaulted.id).source, "default");

      /*
       * ⭐ **`"0"` must pass.** It is the one value this whole feature is for,
       * and a validator written with a truthiness test refuses precisely it
       * while passing every other case.
       */
      check("zero is a legal limit", checkSettingValue("machines.per_user", "0"), null);
      check("and it means nobody may add one", (() => {
        writeSetting(db, "machines.per_user", "0", "u_admin");
        return instanceMachineLimit(db);
      })(), 0);
      report(
        "a number with anything after it is refused, because parseInt would have taken it",
        checkSettingValue("machines.per_user", "5 machines") !== null,
        String(checkSettingValue("machines.per_user", "5 machines")),
      );
      report(
        "and so is a negative one",
        checkSettingValue("machines.per_user", "-1") !== null,
        String(checkSettingValue("machines.per_user", "-1")),
      );
      report(
        "and one above the fleet ceiling",
        checkSettingValue("machines.per_user", String(MAX_MACHINES_PER_USER + 1)) !== null,
        String(checkSettingValue("machines.per_user", String(MAX_MACHINES_PER_USER + 1))),
      );
      check("the ceiling itself is fine", checkSettingValue("machines.per_user", String(MAX_MACHINES_PER_USER)), null);

      // A fresh account on a closed instance: refused, and told what to do
      // rather than given arithmetic.
      const closed = withKey("closedout");
      const refusal = await post("/v1/machines", { name: "laptop" }, closed.headers);
      // One read: `outcome` and `message` each consume the body, and a `clone`
      // of a consumed response throws.
      const refused = (await refusal.json()) as { error?: { code?: string; message?: string } };
      check(
        "creating a machine at a limit of zero is refused",
        [refusal.status, refused.error?.code ?? "ok"],
        [409, "machine_limit"],
      );
      report(
        "and the sentence names the remedy rather than saying 'at most 0'",
        (refused.error?.message ?? "").includes("Ask whoever runs it"),
        refused.error?.message ?? "",
      );

      // ⭐ An ownerless machine is *unlimited* — the `?.over ?? true` guard,
      // which would take every pre-ownership machine in every existing database
      // off the network on deploy.
      const orphan = addMachine("m_orphan_quota");
      check("a machine nobody owns has no standing at all", machineStanding(db, orphan), null);
      report(
        "and is therefore not in the over-limit set, even at a limit of zero",
        !overLimitMachineIds(db).has(orphan),
        `default ${instanceMachineLimit(db)}`,
      );

      clearSetting(db, "machines.per_user");
      if (held === undefined) delete process.env[variable];
      else process.env[variable] = held;
    }

    /* -- the ceiling holds above the configurable limit -------------------- */

    {
      const ceilinged = withKey("ceilinged");
      check(
        "an override above the fleet ceiling is refused on the route",
        await outcome(
          await send(`/v1/admin/users/${ceilinged.id}/machine-limit`, {
            method: "PUT",
            headers: admin.headers,
            body: JSON.stringify({ maxMachines: MAX_MACHINES_PER_USER + 1 }),
          }),
        ),
        [400, "bad_request"],
      );
      // Written straight into the table, as a release with a higher ceiling
      // would have left it. The read side clamps rather than trusting the row.
      db.prepare(
        "INSERT INTO user_machine_limits (user_id, max_machines, updated_at, updated_by) VALUES (?, ?, ?, ?)",
      ).run(ceilinged.id, 999, now, "u_admin");
      check("and a row written past it still reads as the ceiling", effectiveLimit(db, ceilinged.id).limit, MAX_MACHINES_PER_USER);
      clearMachineLimit(db, ceilinged.id);
    }

    /* -- what the admin routes answer -------------------------------------- */

    {
      const watched = withKey("watched");
      const a = newId("m");
      const b = newId("m");
      for (const [id, label, at] of [
        [a, "older", now + 10],
        [b, "newer", now + 20],
      ] as const) {
        db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
          id,
          watched.id,
          label,
          at,
        );
      }

      const lowered = (await (
        await send(`/v1/admin/users/${watched.id}/machine-limit`, {
          method: "PUT",
          headers: admin.headers,
          body: JSON.stringify({ maxMachines: 1 }),
        })
      ).json()) as { maxMachines: number; source: string; owned: number; suspended: { id: string; label: string }[] };
      check(
        "lowering answers with what it switched off, newest last",
        [lowered.maxMachines, lowered.source, lowered.owned, lowered.suspended.map((m) => m.label)],
        [1, "user", 2, ["newer"]],
      );
      // ⭐ Nothing was deleted. That is the difference from a revoke, and it is
      // the sentence the admin screen puts in front of somebody before they
      // confirm.
      check(
        "and deleted nothing",
        Number(db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?").get(watched.id)?.["n"]),
        2,
      );

      const cleared = (await (
        await send(`/v1/admin/users/${watched.id}/machine-limit`, { method: "DELETE", headers: admin.headers })
      ).json()) as { source: string; suspended: unknown[] };
      check("clearing hands back the instance default", [cleared.source, cleared.suspended.length], ["default", 0]);
      check(
        "the limit routes refuse an unknown user",
        await outcome(
          await send("/v1/admin/users/u_nope/machine-limit", {
            method: "PUT",
            headers: admin.headers,
            body: JSON.stringify({ maxMachines: 1 }),
          }),
        ),
        [404, "user_not_found"],
      );
      check(
        "and a non-integer",
        await outcome(
          await send(`/v1/admin/users/${watched.id}/machine-limit`, {
            method: "PUT",
            headers: admin.headers,
            body: JSON.stringify({ maxMachines: 1.5 }),
          }),
        ),
        [400, "bad_request"],
      );

      /*
       * ⭐ **`GET /v1/me` computes `canAddMachine` rather than leaving it to the
       * client**, including the 0/0 case — somebody with no machines and a limit
       * of zero, which is the "ask an admin" state and the one a `count < limit`
       * written client-side would get right only by accident.
       */
      const meOf = async (headers: Record<string, string>) =>
        (await (await send("/v1/me", { headers })).json()) as {
          machineCount: number;
          machineLimit: number;
          canAddMachine: boolean;
        };
      writeMachineLimit(db, watched.id, 2, "u_admin");
      check("within the limit, they may add one", await meOf(watched.headers).then((m) => [m.machineCount, m.machineLimit, m.canAddMachine]), [2, 2, false]);
      writeMachineLimit(db, watched.id, 3, "u_admin");
      check("with room, they may", await meOf(watched.headers).then((m) => m.canAddMachine), true);
      const nobody = withKey("nobody");
      writeMachineLimit(db, nobody.id, 0, "u_admin");
      check("no machines and a limit of zero is still a no", await meOf(nobody.headers).then((m) => [m.machineCount, m.machineLimit, m.canAddMachine]), [0, 0, false]);
      clearMachineLimit(db, watched.id);
      clearMachineLimit(db, nobody.id);
    }

    /* -- re-labelling must not move a machine to the back of its own queue -- */

    {
      /*
       * ⭐ **The bug this feature creates, and the one nobody would find by
       * hand.** `PUT /v1/admin/machines/:id/owner` is a transfer *and* the
       * admin's only re-label, and it did `releaseOwner` + `INSERT … now`
       * unconditionally. For a transfer that is right — the machine becomes the
       * new owner's newest acquisition. For a re-label it silently moves the
       * machine to the back of its own owner's queue and changes which of their
       * machines the limit switches off.
       */
      const keeper = withKey("keeper");
      const taker = withKey("taker");
      const held = newId("m");
      db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
        held,
        `held-${held}`,
        now,
        now,
      );
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        held,
        keeper.id,
        "held",
        now - 90_000,
      );
      const acquiredAt = (): number =>
        Number(db.prepare("SELECT created_at FROM machine_owners WHERE machine_id = ?").get(held)?.["created_at"]);

      const before = acquiredAt();
      await send(`/v1/admin/machines/${held}/owner`, {
        method: "PUT",
        headers: admin.headers,
        body: JSON.stringify({ userId: keeper.id, label: "renamed" }),
      });
      check("re-labelling a machine its owner already owns keeps when they acquired it", acquiredAt(), before);

      await send(`/v1/admin/machines/${held}/owner`, {
        method: "PUT",
        headers: admin.headers,
        body: JSON.stringify({ userId: taker.id, label: "taken" }),
      });
      report(
        "and a real transfer does move it, because that is a new acquisition",
        acquiredAt() > before,
        `${before} -> ${acquiredAt()}`,
      );
    }

    /* -- a credential does not outlive the person -------------------------- */

    {
      /*
       * ⭐ `PRAGMA foreign_keys = OFF`, so every per-user table is swept by hand
       * in the delete route. A left-behind override is a limit that returns from
       * the dead if an id is ever reused, and it is invisible in every list.
       */
      const doomed = withKey("doomed");
      writeMachineLimit(db, doomed.id, 7, "u_admin");
      await send(`/v1/admin/users/${doomed.id}`, { method: "DELETE", headers: admin.headers });
      check(
        "deleting a user takes their machine-limit row with them",
        Number(db.prepare("SELECT COUNT(*) AS n FROM user_machine_limits WHERE user_id = ?").get(doomed.id)?.["n"]),
        0,
      );
    }
  }

  /* -- the fleet provisioning key ---------------------------------------- */

  {
    /*
     * **One credential that adds a daemon for anybody, and the properties that
     * keep it from being an admin key.**
     *
     * It exists because adding a machine needed a credential belonging to
     * whoever would own it, so an admin setting up somebody's host had to borrow
     * their account or hand them one. What is asserted here is mostly what it
     * *cannot* do.
     */
    const provisioned = withKey("provisionadmin", true);
    const target = withKey("provisionee");
    // No `authorization` at all, which is the point of every `post(…, bare)`
    // below: this credential is not a person's.
    const bare = { "content-type": "application/json" };

    const mintKey = async (): Promise<string> =>
      (
        (await (
          await send("/v1/admin/provisioning-key", { method: "POST", headers: provisioned.headers })
        ).json()) as { key: string }
      ).key;
    const exists = async (): Promise<boolean> =>
      (
        (await (
          await send("/v1/admin/provisioning-key", { headers: provisioned.headers })
        ).json()) as { minted: boolean }
      ).minted;

    check(
      "with no key minted, the route refuses everything",
      await outcome(await post("/v1/provision", { key: "pk_nope", user: target.id, machine: "box" }, bare)),
      [401, "invalid_provisioning_key"],
    );
    check("and the status route says there is none", await exists(), false);

    const first = await mintKey();
    report("a minted key is a pk_", first.startsWith("pk_"), first.slice(0, 3));
    check("and the status route now says one exists", await exists(), true);
    /*
     * ⭐ **The status route answers a boolean and nothing else.** Nothing draws
     * this key or any part of it — not the value, not a prefix, not an id — so a
     * richer projection would exist only to be a second place it can leak from,
     * which is the rule `smtp.password` already follows.
     */
    check(
      "and carries no key material of any kind",
      Object.keys(
        (await (await send("/v1/admin/provisioning-key", { headers: provisioned.headers })).json()) as object,
      ),
      ["minted"],
    );

    /*
     * ⭐ **It needs no account at all**, which is the whole feature: `bare` has
     * no `authorization` header. If this ever starts needing one, the reason the
     * key exists has gone.
     */
    const made = await post("/v1/provision", { key: first, user: target.id, machine: "provisioned" }, bare);
    check("provisioning needs no caller credential", made.status, 201);
    const answer = (await made.json()) as {
      machine: { id: string; name: string };
      owner: { id: string };
      enrollment: { code: string };
      machineLimitRaisedTo: number | null;
    };
    check("and the machine belongs to the named user", answer.owner.id, target.id);
    check(
      "with an ownership row, so it is inside both gates",
      db.prepare("SELECT user_id FROM machine_owners WHERE machine_id = ?").get(answer.machine.id)?.["user_id"],
      target.id,
    );
    check(
      "and a grant, so they can actually see it",
      db.prepare("SELECT COUNT(*) AS n FROM grants WHERE machine_id = ? AND user_id = ?").get(answer.machine.id, target.id)?.["n"],
      1,
    );
    /*
     * ⭐ `created_by` on the code is the **key's** id, not the owner's. Writing
     * the owner there would say they minted a code for a host they have never
     * heard of, in the one column that is an enrollment code's only trail.
     */
    report(
      "the enrollment code records the key that minted it, not the owner",
      String(
        db.prepare("SELECT created_by FROM enrollment_codes WHERE machine_id = ?").get(answer.machine.id)?.["created_by"],
      ).startsWith("pk_"),
      String(db.prepare("SELECT created_by FROM enrollment_codes WHERE machine_id = ?").get(answer.machine.id)?.["created_by"]),
    );

    /* ⭐ The limit is raised rather than the request refused. */
    writeMachineLimit(db, target.id, 1, "u_admin");
    const second = (await (
      await post("/v1/provision", { key: first, user: target.id, machine: "second" }, bare)
    ).json()) as { machineLimitRaisedTo: number | null };
    /*
     * `owned + 1`, not `limit + 1`: they owned one and were capped at one, so
     * two is exactly enough for the machine being provisioned and not a unit
     * more. Incrementing an already-generous limit would quietly widen it.
     */
    check("at their limit, provisioning raises it to fit and no further", second.machineLimitRaisedTo, 2);
    /*
     * Scoped to this user — `overLimitMachineIds` is fleet-wide and this driver's
     * earlier blocks deliberately leave machines over their owners' limits.
     */
    const theirs = db
      .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ?")
      .all(target.id)
      .map((row) => String(row["machine_id"]));
    const switchedOff = theirs.filter((id) => overLimitMachineIds(db).has(id));
    report("and every machine they own works rather than being switched off", switchedOff.length === 0, `${theirs.length} owned, ${switchedOff.length} over`);
    check(
      "the raise is a visible override rather than a silent number",
      effectiveLimit(db, target.id).source,
      "user",
    );

    /*
     * ⭐ **Reminting retires the previous key in the same act**, which is the
     * whole rotation story: the reason to mint a second is that the first
     * leaked, so a window in which both work is the window being closed. There
     * is no separate revoke and no "off" — one key, one verb.
     */
    const reminted = await mintKey();
    check(
      "reminting stops the old key at once",
      await outcome(await post("/v1/provision", { key: first, user: target.id, machine: "stale" }, bare)),
      [401, "invalid_provisioning_key"],
    );
    /*
     * The fourth code-minting route, driven against an app that trusts one proxy
     * hop: what this answers goes straight into an env file on a host somebody is
     * provisioning, and `publicUrl` alone reads `http://` behind every TLS proxy.
     */
    const proxiedApp = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry, trustedProxyHops: 1 });
    const provisionedProxied = (await (
      await proxiedApp.request("/v1/provision", {
        method: "POST",
        headers: { ...bare, "x-forwarded-proto": "https" },
        body: JSON.stringify({ key: reminted, user: target.id, machine: "proxied-provision" }),
      })
    ).json()) as { controlPlaneUrl?: string };
    check("a provisioned machine's controlPlaneUrl honours a trusted x-forwarded-proto", provisionedProxied.controlPlaneUrl?.startsWith("https://"), true);
    check(
      "while the new one works",
      (await post("/v1/provision", { key: reminted, user: target.id, machine: "fresh" }, bare)).status,
      201,
    );
    check("and there is still exactly one live row", 
      db.prepare("SELECT COUNT(*) AS n FROM provisioning_keys WHERE revoked_at IS NULL").get()?.["n"], 1);

    /* -- what it may not do ------------------------------------------------ */

    check(
      "it is not a caller credential — it authenticates nothing else",
      (await send("/v1/me", { headers: { authorization: `Bearer ${reminted}` } })).status,
      401,
    );
    check(
      "nor an admin one",
      (await send("/v1/admin/users", { headers: { authorization: `Bearer ${reminted}` } })).status,
      401,
    );
    check(
      "an unknown user is a 404 rather than a machine nobody owns",
      await outcome(await post("/v1/provision", { key: reminted, user: "u_nobody", machine: "ghost" }, bare)),
      [404, "user_not_found"],
    );
    // A banned account's machines are switched off the moment they exist, so
    // provisioning one would hand somebody an installer that cannot work.
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, target.id);
    check(
      "and a banned user is refused rather than given a dead machine",
      await outcome(await post("/v1/provision", { key: reminted, user: target.id, machine: "banned" }, bare)),
      [403, "user_disabled"],
    );
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(target.id);
    clearMachineLimit(db, target.id);

    /*
     * ⭐ **A refused provision changes nothing**, which it did not.
     *
     * The limit was raised *before* `createOwnedMachine` and neither refusal arm
     * undid it, so a failed request permanently widened somebody's quota. The
     * ceiling arm is the one that matters: at fifty machines under an admin-set
     * limit of five, `min(51, 50)` was written and the create then refused
     * `too_many` — a 409 that had just un-suspended forty-five machines an admin
     * deliberately switched off, reported nowhere, because `machineLimitRaisedTo`
     * only rides the 201.
     *
     * Fifty rows rather than a smaller fixture because that is the only way to
     * reach the arm: every other refusal happens before the write.
     */
    {
      const full = withKey("provisionfull");
      for (let index = 0; index < MAX_MACHINES_PER_USER; index += 1) {
        const id = newId("m");
        db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, ?, ?)").run(id, `full-${id}`, now + index);
        db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
          id,
          full.id,
          `box${index}`,
          now + index,
        );
      }
      writeMachineLimit(db, full.id, 5, "u_admin");
      const suspendedBefore = [...overLimitMachineIds(db)].length;

      check(
        "provisioning at the fleet ceiling is refused",
        await outcome(await post("/v1/provision", { key: reminted, user: full.id, machine: "fiftyfirst" }, bare)),
        [409, "machine_limit"],
      );
      check("and the refusal left their limit exactly as it found it", effectiveLimit(db, full.id).limit, 5);
      report(
        "so nothing was un-suspended by a request that failed",
        [...overLimitMachineIds(db)].length === suspendedBefore,
        `${[...overLimitMachineIds(db)].length} over, was ${suspendedBefore}`,
      );
      clearMachineLimit(db, full.id);
    }

    /*
     * ⭐ **A name that folds onto two accounts is refused rather than guessed.**
     *
     * `users.name` is UNIQUE and SQLite compares it BINARY, `idx_users_name_folded`
     * is a plain index, and `POST /v1/admin/users` checks the name exactly — so
     * `Casey` and `casey` can both exist. Resolved with `.get()`, whichever row
     * SQLite yielded first decided who got a machine, an `ALL_SCOPES` grant and a
     * raised limit, and whose `disabled_at` the ban check read. A provisioning key
     * holder asking for one person could hand the host to another.
     */
    {
      const upper = newId("u");
      const lower = newId("u");
      db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'Casey', 0, ?)").run(upper, now);
      db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'casey', 0, ?)").run(lower, now);
      check(
        "a name two accounts share bar case is refused, not resolved",
        await outcome(await post("/v1/provision", { key: reminted, user: "casey", machine: "ambiguous" }, bare)),
        [409, "user_ambiguous"],
      );
      check(
        "while the id is unambiguous and still works",
        (await post("/v1/provision", { key: reminted, user: lower, machine: "byid" }, bare)).status,
        201,
      );
      report(
        "and it landed on the account that was named, not its case-twin",
        Number(db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?").get(upper)?.["n"]) === 0,
        `upper owns ${String(db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?").get(upper)?.["n"])}`,
      );
    }

    /*
     * ⭐ **Last, deliberately.** This spends the `provisionKey` budget for this
     * driver's one address, so every `/v1/provision` above would answer 429 after
     * it — `enrollKey`'s block makes the same arrangement for the same reason.
     *
     * It is the only defence there is against guessing a credential that is
     * long-lived, fleet-wide, and whose stated threat is inserting a machine of
     * the holder's own into anybody's list. Counted on every attempt rather than
     * on failures, because the credential *is* the body and there is no identity
     * here to be fair to.
     */
    {
      let refusedAt = -1;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const answer = await post("/v1/provision", { key: "pk_guess", user: target.id, machine: `spray${attempt}` }, bare);
        if (answer.status === 429 && refusedAt < 0) refusedAt = attempt;
      }
      report("guessing a provisioning key is counted and then refused", refusedAt >= 0, `first 429 at attempt ${refusedAt}`);
      check(
        "and a *correct* key is refused while the block holds, because the counter is the address",
        (await post("/v1/provision", { key: reminted, user: target.id, machine: "blocked" }, bare)).status,
        429,
      );
    }
  }

  /* -- registering a machine for somebody, through the admin door --------- */

  {
    /*
     * **The one creation path that skipped the wider clash check**, and it is
     * the path `deploy/install.sh`'s daemon wizard drives when the control plane
     * is on the same host.
     *
     * `createOwnedMachine` leans on the unique index on `(user_id, label)`,
     * which is deliberately narrow — it is what lets two people each have a
     * "laptop" — and says nothing about a machine somebody *shared* with this
     * person or a legacy row they see under `machines.name`. Those are exactly
     * what an admin registering a machine *for* somebody collides with, and the
     * result was two indistinguishable rows in one person's list with
     * `POST /v1/tokens {machine:"<name>"}` silently resolving to whichever
     * `resolveMachineRef` reached first.
     *
     * **Only two shapes discriminate, and neither is the obvious one.** Posting
     * a name the owner already owns *in the same case* is refused either way —
     * the unique index catches it and answers the same 409 with the same code —
     * so a case built on that would have been green before the guard existed.
     * What is left is a machine they can see but do not own, and a label that
     * differs only in case: the index is BINARY and `nameVisibleTo` folds.
     */
    const shared = withKey("hollerith");
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_legacy_bb', 'buildbox', ?)").run(now);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, 'm_legacy_bb', 'session:read', ?)").run(shared.id, now);

    // Her own route already refuses this, and has since `nameVisibleTo` existed.
    // The pair is the point: the same name, the same person, the other door.
    check("her own route refuses a name she can already see", await outcome(await post("/v1/machines", { name: "buildbox" }, shared.headers)), [409, "machine_exists"]);
    check("and so does an admin registering it for her", await outcome(await post("/v1/admin/machines", { name: "buildbox", ownerId: shared.id }, admin.headers)), [409, "machine_exists"]);

    check("a machine she owns is registered", (await post("/v1/machines", { name: "desk" }, shared.headers)).status, 201);
    check("and the admin door refuses it spelled in another case", await outcome(await post("/v1/admin/machines", { name: "DESK", ownerId: shared.id }, admin.headers)), [409, "machine_exists"]);

    /*
     * Not a blanket refusal — the guard has to let the ordinary case through,
     * which is the whole reason the wizard calls this route. Asserted through
     * her own list rather than through the 201, because what the route is *for*
     * is a machine that appears in somebody's list.
     */
    const registered = await post("/v1/admin/machines", { name: "plotter", ownerId: shared.id }, admin.headers);
    check("a name nobody can see still registers", registered.status, 201);
    const registeredId = ((await registered.json()) as { id?: string }).id ?? "";
    const plotter = ((await (await send("/v1/machines", { headers: shared.headers })).json()) as {
      machines: { id: string; name: string; owned?: boolean }[];
    }).machines.find((machine) => machine.id === registeredId);
    check("and lands in her list, owned, under the label the admin chose", [plotter?.name, plotter?.owned], ["plotter", true]);

    /*
     * ⭐ **The ownerless arm is gone, and this is what stops it coming back.**
     *
     * It used to be the other half of this route: no `ownerId`, no owner, and
     * the only clash check was the global `machines.name`. That was one of two
     * ways to manufacture a live machine outside both the machine limit and the
     * ban check — reachable by forgetting one flag.
     *
     * Pinned as a *refusal* rather than deleted from the file, because the
     * tempting tidy-up is to make `ownerId` optional again "so the admin routes
     * can still describe legacy machines". Describing them is
     * `GET /v1/admin/machines`, which is untouched; making more of them is not
     * the same act.
     */
    check(
      "registering a machine with no owner is refused",
      await outcome(await post("/v1/admin/machines", { name: "unowned-rack" }, admin.headers)),
      [400, "bad_request"],
    );
    report(
      "and the refusal says why an ownerless machine is the problem",
      (await message(await post("/v1/admin/machines", { name: "unowned-rack" }, admin.headers))).includes(
        "outside the machine limit",
      ),
      await message(await post("/v1/admin/machines", { name: "unowned-rack" }, admin.headers)),
    );
    check(
      "an empty ownerId is refused as well as a missing one",
      await outcome(await post("/v1/admin/machines", { name: "unowned-rack", ownerId: "" }, admin.headers)),
      [400, "bad_request"],
    );
  }

  /* -- renaming one, through the same door ------------------------------- */

  {
    /*
     * **The sixth naming door, and the one this repository documents.**
     * `PATCH /v1/admin/machines/:id` is what `cpctl admin setmachine <id> --name
     * <n>` drives, and it writes `machines.name` after asking only whether that
     * globally `UNIQUE` column is free. That question cannot see the collision
     * `nameVisibleTo` exists for, because an *owned* machine's row name is
     * `qualifiedName(label, id)` — `laptop-1a2b3c4d`, never the bare word — so
     * renaming a legacy row to `laptop` sailed past it, and the person holding a
     * grant on both then read two indistinguishable `laptop` rows with
     * `POST /v1/tokens {machine:"laptop"}` silently resolving to whichever
     * `resolveMachineRef` reached first, leaving the other unreachable by name.
     *
     * The qualified name is *reported* rather than assumed, because it is the
     * whole reason the old check missed: if that column ever became the bare
     * label, every refusal below would come from the global test instead and
     * this block would pass while asserting nothing.
     */
    const ada = withKey("adalegacy");
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_legacy_rn', 'rackmount', ?)").run(now);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, 'm_legacy_rn', 'session:read', ?)").run(ada.id, now);
    const hers = (await (await post("/v1/machines", { name: "laptop" }, ada.headers)).json()) as {
      machine: { id: string };
    };
    const rowName = (id: string): string =>
      String(db.prepare("SELECT name FROM machines WHERE id = ?").get(id)?.["name"] ?? "");
    report("her own machine's row name is the qualified one", rowName(hers.machine.id).startsWith("laptop-"), rowName(hers.machine.id));

    const rename = (id: string, name: string): Promise<Response> =>
      send(`/v1/admin/machines/${id}`, { method: "PATCH", headers: admin.headers, body: JSON.stringify({ name }) });

    check("renaming a legacy row onto a name its grantee can see is a 409", await outcome(await rename("m_legacy_rn", "laptop")), [409, "machine_exists"]);
    // The `machines.name` index is BINARY and `nameVisibleTo` folds, so this
    // spelling is refused by the new check alone — two rows reading `LAPTOP` and
    // `laptop` in one list are as indistinguishable as two reading `laptop`.
    check("and case does not dodge it", await outcome(await rename("m_legacy_rn", "LAPTOP")), [409, "machine_exists"]);
    check("the row keeps the name it had", rowName("m_legacy_rn"), "rackmount");

    // Not a blanket refusal: this route is the only way to change a legacy
    // machine's name at all, and taking that away would leave editing SQLite.
    check("a name nobody can see still renames", (await rename("m_legacy_rn", "rack-two")).status, 200);
    check("and the row moves", rowName("m_legacy_rn"), "rack-two");

    /*
     * **The owner is deliberately not asked.** `labelOrName` hands them their
     * own `machine_owners.label`, so this column is invisible to them, and
     * asking anyway would refuse an admin a rename over a collision the owner
     * can never see — a 409 nothing on screen could explain. Ada owns `laptop`
     * and `desk`; the row name behind the first is free to become `desk`.
     */
    check("a machine she owns is registered", (await post("/v1/machines", { name: "desk" }, ada.headers)).status, 201);
    check("the owner's own list does not block a rename of the row behind it", (await rename(hers.machine.id, "desk")).status, 200);
    check("and her label is untouched", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(hers.machine.id)?.["label"], "laptop");

    /*
     * The other half of that same sentence: what `machines.name` decides is what
     * everybody on the grant list who does **not** own it reads, so a second
     * grantee is shadowed exactly as the legacy case is. That arm is why the
     * check enumerates the grant list rather than asking `ownerOf` alone.
     */
    const kilburn = withKey("kilburn");
    check("a second person has a machine of their own", (await post("/v1/machines", { name: "bench" }, kilburn.headers)).status, 201);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, 'session:read', ?)").run(kilburn.id, hers.machine.id, now);
    check("and a grantee who is not the owner is shadowed the same way", await outcome(await rename(hers.machine.id, "bench")), [409, "machine_exists"]);
  }

  /* -- a code a deleted user was holding --------------------------------- */

  {
    /*
     * **The hole `burnUserCodes` closes, driven end to end.** Deleting a user
     * swept sessions, origins, passwords, API keys, grants and ownership — and
     * not the one credential that lives in the table the route had decided not
     * to rewrite. `/v1/enroll` sits *above* THE LINE and asks only whether a
     * code is unused and unexpired, so a just-deleted account could redeem one,
     * receive the machine id and the fleet's public keys, and have
     * `issueTunnelKey` retire the legitimate daemon's key in the same call.
     */
    const leaving = withKey("leaving");
    const theirs = (await (await post("/v1/machines", { name: "their-box" }, leaving.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    const gone = (await (await send(`/v1/admin/users/${leaving.id}`, { method: "DELETE", headers: admin.headers })).json()) as {
      enrollmentCodesInvalidated: number;
      machinesRevoked: number;
    };
    check("the delete reports the code it burned", [gone.enrollmentCodesInvalidated, gone.machinesRevoked], [1, 1]);
    check("and the code no longer redeems", await outcome(await post("/v1/enroll", { code: theirs.enrollment.code }, { "content-type": "application/json" })), [409, "code_unusable"]);
    /*
     * `used_from` is the only forensic trail there is, so a delete and a revoke
     * have to be distinguishable in it. `created_by` is still left dangling on
     * purpose — the row's job is to say what happened, and rewriting history to
     * keep a join valid is the opposite of an audit trail.
     */
    const row = db.prepare("SELECT created_by, used_from FROM enrollment_codes WHERE machine_id = ?").get(theirs.machine.id);
    check("burned as a deletion rather than as a revocation", row?.["used_from"], "user_deleted");
    check("and the audit row still names who minted it", row?.["created_by"], leaving.id);
  }

  /* -- a code a *disabled* user was holding ------------------------------- */

  {
    /*
     * **The same hole, reached through the reversible remedy.** Everything else
     * that authenticates as this person goes through `callerAuth`, which reads
     * `disabled_at` live, so a ban lands on their very next request — which is
     * exactly why nobody looked here. `/v1/enroll` is registered *above* THE
     * LINE: it has no caller to read that column from, and it asks only whether
     * the code is unused and unexpired. So offboarding somebody at 10:05 who
     * minted a code at 10:00 left them able to POST it at 10:06 from anywhere
     * with no credential, receive the machine id and the fleet's public keys,
     * and have `issueTunnelKey` retire the running daemon's tunnel key in the
     * same call — a banned account taking a machine off the relay and putting
     * itself on it.
     *
     * The two halves are asserted beside each other deliberately: the credential
     * that was already refused, and the one that was not.
     */
    const banned = withKey("offboarded");
    const theirs = (await (await post("/v1/machines", { name: "bench-box" }, banned.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    const disabled = (await (await post(`/v1/admin/users/${banned.id}/disable`, {}, admin.headers)).json()) as {
      enrollmentCodesInvalidated: number;
    };
    check("disabling reports the code it burned", disabled.enrollmentCodesInvalidated, 1);
    check("their API key stops working on the next request", await outcome(await send("/v1/me", { headers: banned.headers })), [403, "user_disabled"]);
    check("and the code stops being a machine identity", await outcome(await post("/v1/enroll", { code: theirs.enrollment.code }, { "content-type": "application/json" })), [409, "code_unusable"]);
    /*
     * Distinguishable from a delete in the only column that records either.
     * Reusing `'user_deleted'` here would say a person who is still in the table
     * had been removed from it, in the one place there is to look.
     */
    check("burned as a ban rather than as a deletion", db.prepare("SELECT used_from FROM enrollment_codes WHERE machine_id = ?").get(theirs.machine.id)?.["used_from"], "user_disabled");
    /*
     * And it is **not** given back, which is the trade `enable` already states
     * about sessions: re-enabling restores the account, not the credentials that
     * were live while it was somebody's problem. A code lasts an hour and
     * minting another is one request.
     */
    check("enabling them again is allowed", (await post(`/v1/admin/users/${banned.id}/enable`, {}, admin.headers)).status, 200);
    check("and does not give the code back", await outcome(await post("/v1/enroll", { code: theirs.enrollment.code }, { "content-type": "application/json" })), [409, "code_unusable"]);
  }

  /* -- a code minted *for* somebody, which `created_by` cannot see --------- */

  {
    /*
     * **`burnUserCodes` keys on `created_by`, and that is the wrong column for
     * half the question.** The two sweeps above burn what the offboarded person
     * *minted*. `POST /v1/admin/machines/:id/enrollments` — `cpctl admin enroll`
     * — mints one *for* them: the admin is `created_by`, the machine is theirs,
     * and both sweeps walked straight past it. So the sentence the case above
     * exists to make true was reachable with the code somebody was **handed**
     * rather than the one they made, with everything downstream unchanged —
     * machine id, fleet public keys, and an `issueTunnelKey` that retires the
     * running daemon's tunnel key.
     *
     * Asserted through the admin door specifically, because the owner's own
     * `POST /v1/machines/:id/enrollments` records them as `created_by` and is
     * therefore already covered.
     */
    const holder = withKey("handed-a-code");
    const theirs = (await (await post("/v1/machines", { name: "handed-box" }, holder.headers)).json()) as {
      machine: { id: string };
    };
    // Flat, unlike the owner's own route — that one answers `{machine,
    // enrollment}` and this one answers the code directly.
    const handed = (await (
      await post(`/v1/admin/machines/${theirs.machine.id}/enrollments`, {}, admin.headers)
    ).json()) as { code: string };
    check(
      "the admin is recorded as having minted it, not the owner",
      db.prepare("SELECT created_by FROM enrollment_codes WHERE machine_id = ? AND used_at IS NULL").get(theirs.machine.id)?.["created_by"],
      admin.id,
    );

    const disabled = (await (await post(`/v1/admin/users/${holder.id}/disable`, {}, admin.headers)).json()) as {
      enrollmentCodesInvalidated: number;
    };
    check("disabling them burns it anyway", disabled.enrollmentCodesInvalidated, 1);
    check(
      "so a code somebody was handed is not a way back either",
      await outcome(await post("/v1/enroll", { code: handed.code }, { "content-type": "application/json" })),
      [409, "code_unusable"],
    );
    check(
      "and it says which of the two acts burned it",
      db.prepare("SELECT used_from FROM enrollment_codes WHERE machine_id = ? AND created_by = ?").get(theirs.machine.id, admin.id)?.["used_from"],
      "user_disabled",
    );
  }

  /* -- guessing at an enrollment code costs something --------------------- *
   *
   * **Last, deliberately.** This spends the whole `enrollKey` budget for this
   * driver's one address, and every `/v1/enroll` above would answer `429` rather
   * than the code it was written to assert if this ran first. Its own namespace
   * is what keeps the damage to that route: the same block asserts that signing
   * in from the same address is untouched, which is the property `addressKey`
   * would have broken by sharing.
   * ----------------------------------------------------------------------- */

  {
    /*
     * `POST /v1/enroll` was the one route above THE LINE that took a body and
     * counted nothing. Not what makes a code unguessable — 256 bits of CSPRNG
     * is — but what stops an unauthenticated caller driving one WAL writer-lock
     * acquisition per request against the file the relay process shares.
     */
    const bare = { "content-type": "application/json" };
    let refusedAt = -1;
    for (let i = 0; i < ADDRESS_THROTTLE.threshold + 2; i += 1) {
      const answer = await post("/v1/enroll", { code: `guess-${i}` }, bare);
      if (answer.status === 429 && refusedAt < 0) refusedAt = i;
    }
    report(
      "guessing is refused before the attempts are unbounded",
      refusedAt >= 0 && refusedAt <= ADDRESS_THROTTLE.threshold,
      `first 429 at attempt ${refusedAt}`,
    );
    check(
      "and the refusal says how long to wait",
      typeof (
        (await (await post("/v1/enroll", { code: "again" }, bare)).json()) as {
          error?: { detail?: { retryAfterSeconds?: number } };
        }
      ).error?.detail?.retryAfterSeconds,
      "number",
    );
    /*
     * The namespace, driven rather than derived: `enrollKey` and `addressKey`
     * share one `LoginThrottle` instance, so the only thing keeping a machine
     * enrolling behind a NAT from spending the budget that gates *signing in*
     * from it is that the two keys are in different spaces.
     */
    check(
      "and it has not touched signing in from the same address",
      (await post("/v1/login", { name: "fleetadmin", password: "no such password" }, bare)).status,
      401,
    );
  }

  /* -- an ownerless machine getting an owner ----------------------------- */

  {
    /*
     * **Ownerless was a one-way state.** `INSERT INTO machine_owners` happened
     * in exactly one place, `createOwnedMachine`, which always mints a fresh id
     * — so *becoming* an owner was inseparable from *creating* a machine, and a
     * machine left ownerless could never have an owner again: rename, re-enroll
     * and revoke all resolve through `ownerOf` and answer 404 for the life of
     * the row. A person leaving the fleet stranded their hardware, and the only
     * remedy was editing SQLite.
     *
     * **The orphan is made by SQL now, and that is the point rather than a
     * workaround.** No route creates a live ownerless machine any more — deleting
     * a user revokes theirs, and `POST /v1/admin/machines` requires an `ownerId`.
     * What is left is the *legacy* row: a machine registered before
     * `machine_owners` existed, which is exactly the shape below and exactly
     * what this route exists to rescue. Building it by hand is the only honest
     * way to test that now.
     */
    const turing = withKey("turing");
    const orphan = { id: newId("m") };
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, 'orphan-box', ?)").run(orphan.id, now);
    const patch = (headers: Record<string, string>, name: string): Promise<Response> =>
      send(`/v1/machines/${orphan.id}`, { method: "PATCH", headers, body: JSON.stringify({ name }) });

    check("nobody owns it, so every owner route is a 404", [
      (await outcome(await patch(turing.headers, "adopted")))[1],
      (await outcome(await post(`/v1/machines/${orphan.id}/enrollments`, {}, turing.headers)))[1],
      (await outcome(await post(`/v1/machines/${orphan.id}/revoke`, {}, turing.headers)))[1],
    ], ["machine_not_found", "machine_not_found", "machine_not_found"]);

    const adopted = await send(`/v1/admin/machines/${orphan.id}/owner`, {
      method: "PUT",
      headers: admin.headers,
      body: JSON.stringify({ userId: turing.id, label: "adopted" }),
    });
    check("an admin can hand it to somebody", adopted.status, 200);
    /*
     * The grant is written with the ownership row rather than left to a second
     * act — `GET /v1/machines` joins `grants`, so an owner with no grant owns a
     * machine that appears in no list, which is the exact failure user-owned
     * machines exists to remove. Every scope, because without `machine:admin`
     * the owner cannot remove a workspace on their own hardware.
     */
    check("with every scope", [...((await adopted.json()) as { scopes: string[] }).scopes].sort(), ["machine:admin", "session:read", "session:write"]);
    const listed = ((await (await send("/v1/machines", { headers: turing.headers })).json()) as {
      machines: { id: string; name: string; owned?: boolean }[];
    }).machines.find((machine) => machine.id === orphan.id);
    check("and it appears in their list, under their own label", [listed?.name, listed?.owned], ["adopted", true]);

    check("rename now works", (await patch(turing.headers, "adopted-two")).status, 200);
    check("so does re-enrolling", (await post(`/v1/machines/${orphan.id}/enrollments`, {}, turing.headers)).status, 201);
    check("and so does retiring it", (await post(`/v1/machines/${orphan.id}/revoke`, {}, turing.headers)).status, 200);
    // Revoking is what *frees* the label and the quota slot, so handing one back
    // would spend both on a machine nothing can reach.
    check("a revoked machine is not adoptable", await outcome(await send(`/v1/admin/machines/${orphan.id}/owner`, { method: "PUT", headers: admin.headers, body: JSON.stringify({ userId: turing.id, label: "again" }) })), [403, "machine_revoked"]);
  }
}

/* ------------------------------------------------------------------ *
 * The two credential routes that asked nothing, and the write that did
 * not exist
 * ------------------------------------------------------------------ */

process.stdout.write("\nproving it is your own account, and retiring a key\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
  const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
    send(path, { method: "POST", headers, body: JSON.stringify(body) });
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];

  const rootKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_super', 'super', 1, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_super', ?, ?, ?)").run(
    newId("ak"),
    rootKey.prefix,
    rootKey.hash,
    now,
  );
  const superAdmin = { authorization: `Bearer ${rootKey.key}`, "content-type": "application/json" };

  // An admin with a password *and* a key of their own, which is what the two
  // routes below are aimed at when the target is the caller.
  const hopper = (await (await post("/v1/admin/users", { name: "hopper", isAdmin: true }, superAdmin)).json()) as {
    id: string;
    password: string;
  };
  /*
   * **A session rather than a key**, and that is the credential this block is
   * about: the defect it pins is a session token lifted from a tab turning into
   * a permanent one. `withKey` is deleted, so there is no key to hold here
   * anyway — which is itself the point.
   */
  db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(hopper.id);
  const hers = {
    authorization: `Bearer ${
      ((await (await post("/v1/login", { name: "hopper", password: hopper.password }, { "content-type": "application/json" })).json()) as { token: string }).token
    }`,
    "content-type": "application/json",
  };
  const bystander = (await (await post("/v1/admin/users", { name: "bystander" }, superAdmin)).json()) as { id: string };

  /*
   * **The escalation, and where it lives now.**
   *
   * Measured before this existed: `/v1/me/password` correctly refused without
   * `currentPassword`, while `POST /v1/admin/users/<self>/keys` answered 201
   * with a permanent key and `.../password` reset the password outright — both
   * asking nothing. A session token lifted from an admin's tab converted into
   * ownership of the account in exactly one request.
   *
   * Both of those routes are **deleted**. The question they should have been
   * asking is now asked by the two routes that genuinely need it, about the
   * caller and never about an `:id` — so the same defence is asserted here
   * against `POST /v1/me/keys`, which is the one route that still mints a
   * permanent credential.
   */
  check("minting yourself a key needs your password", await outcome(await post("/v1/me/keys", {}, hers)), [400, "bad_request"]);
  check("a wrong one is refused", await outcome(await post("/v1/me/keys", { currentPassword: "not-my-password" }, hers)), [401, "invalid_password"]);
  const second = await post("/v1/me/keys", { currentPassword: hopper.password }, hers);
  check("and the right one mints it", second.status, 201);
  /*
   * **A missing body is an absent field, not its own refusal.** A request with
   * no body at all is the only shape that tells the two apart, because `{}`
   * above reaches the same status and code by the other arm. The sentence is
   * what is asserted: the status and the code are deliberately the same, so
   * `authFailure` on the client reads it identically and does not sign anybody
   * out over a field they were never asked for.
   */
  const messageOf = async (response: Response): Promise<string> =>
    ((await response.json()) as { error?: { message?: string } }).error?.message ?? "(none)";
  const bodiless = await send("/v1/me/keys", {
    method: "POST",
    headers: { authorization: hers.authorization },
  });
  check("and a request carrying no body names the field rather than the body", [bodiless.status, await messageOf(bodiless)], [
    400,
    "currentPassword is required",
  ]);
  /*
   * **And no admin route can be aimed at anybody else at all**, which is the
   * half that used to be here in the opposite form: "aimed at somebody else this
   * asks nothing" was a statement about a route that existed. Both are gone, so
   * what is asserted now is the shape of their absence.
   */
  check(
    "an admin cannot reset a stranger's password",
    (await post(`/v1/admin/users/${bystander.id}/password`, {}, hers)).status,
    404,
  );
  check(
    "nor mint a stranger a key",
    (await post(`/v1/admin/users/${bystander.id}/keys`, {}, hers)).status,
    404,
  );
  /*
   * **A self-service change keeps the keys, deliberately.** The deleted admin
   * reset swept them because it existed for the case where somebody else may
   * hold the account. Changing your own password is not that case, and killing a
   * `cpctl` key somebody is holding because they rotated a password would be a
   * surprise with no upside — `POST /v1/me/password`'s own docblock has always
   * said so, and now it is the only route in the pair.
   */
  const liveKeys = (): number =>
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(hopper.id)?.["n"] ??
        0,
    );
  const keysBefore = liveKeys();
  // Asserted rather than assumed, because "unchanged" over an empty set is a
  // sentence about nothing: this was two identical reads with no request between
  // them for a while, which could not fail and therefore never did.
  check("there is a key to keep in the first place", keysBefore > 0, true);
  check(
    "and the change itself lands",
    (await post("/v1/me/password", { currentPassword: hopper.password, newPassword: "a-fine-new-password" }, hers))
      .status,
    200,
  );
  check("changing your own password leaves your keys alone", liveKeys(), keysBefore);

  /*
   * **`revoked_at` was a column nothing could ever write.** `callerAuth` reads
   * it and answers `api_key_revoked`, so the capability looked present from both
   * ends — the schema has the column, the middleware honours it — while there
   * was no `UPDATE api_keys` anywhere in this service. Deleting the whole user
   * was the only way to retire a key, which on the single-admin deployment
   * `install.sh` creates means a leaked admin key had no in-band remedy at all.
   */
  const curie = (await (await post("/v1/admin/users", { name: "curie" }, superAdmin)).json()) as {
    id: string;
    password: string;
  };
  // Mints their own, because nothing else can. `withKey` is deleted.
  db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(curie.id);
  const curieSession = ((await (await post("/v1/login", { name: "curie", password: curie.password }, { "content-type": "application/json" })).json()) as { token: string }).token;
  const curieKey = ((await (await post("/v1/me/keys", { currentPassword: curie.password }, { authorization: `Bearer ${curieSession}`, "content-type": "application/json" })).json()) as { apiKey: string }).apiKey;
  const theirs = { authorization: `Bearer ${curieKey}`, "content-type": "application/json" };
  const own = (await (await send("/v1/me/keys", { headers: theirs })).json()) as {
    keys: { id: string; prefix: string; revokedAt: number | null }[];
  };
  check("you can list your own keys", own.keys.length, 1);
  // Never the hash and never the key: only the hash was ever stored, so the
  // plaintext is unrecoverable by construction and this projection says so.
  check("and the row carries nothing secret", Object.keys(own.keys[0] ?? {}).sort(), ["createdAt", "id", "prefix", "revokedAt"]);
  const keyId = own.keys[0]?.id ?? "";
  check("revoking the key you are holding is allowed", (await send(`/v1/me/keys/${keyId}`, { method: "DELETE", headers: theirs })).status, 200);
  check("and it stops authenticating immediately", await outcome(await send("/v1/me", { headers: theirs })), [401, "api_key_revoked"]);
  // Revoked rows are listed rather than filtered, unlike the count on
  // `GET /v1/admin/users`: that count answers "how many still work", this list
  // answers "is the one that leaked dead yet", and a row that vanishes on
  // revocation cannot answer it.
  const after = (await (await send(`/v1/admin/users/${curie.id}/keys`, { headers: superAdmin })).json()) as {
    keys: { revokedAt: number | null }[];
  };
  check("the revoked row is still listed, with its timestamp", [after.keys.length, after.keys[0]?.revokedAt !== null], [1, true]);
  // One answer for unknown, already revoked, and somebody else's — the last of
  // which is what the `user_id` clause inside `revokeApiKey` makes true.
  check("a second revoke is a 404", await outcome(await send(`/v1/admin/users/${curie.id}/keys/${keyId}`, { method: "DELETE", headers: superAdmin })), [404, "key_not_found"]);
  check("and so is revoking it as somebody else's", await outcome(await send(`/v1/admin/users/${bystander.id}/keys/${keyId}`, { method: "DELETE", headers: superAdmin })), [404, "key_not_found"]);
  const counted = ((await (await send("/v1/admin/users", { headers: superAdmin })).json()) as {
    users: { id: string; keys: number }[];
  }).users.find((user) => user.id === curie.id);
  check("and the admin list counts only keys that still work", counted?.keys, 0);
}

/* ------------------------------------------------------------------ *
 * cpctl, against the routes it calls
 *
 * `packages/control-plane/scripts/cpctl.ts` is the credential path for
 * everything that is not a browser — a script, a shell, and getting back in when
 * a password is lost — and no driver read it at all. Both defects pinned here
 * have one shape: the CLI and the route disagreeing about a request or a
 * response, with `api<T>`'s cast making the disagreement invisible to `tsc`. A
 * declared type is not a measurement of what the other end sends.
 *
 * The technique is `webcheck`'s, for `enrollmentLines`: that file cannot be
 * imported — its module body reads `process.argv` and dispatches, and neither of
 * these is exported — so its **source is read and its own code is run**, against
 * the real routes in the real app. That is the only form of this check that
 * compares behaviour rather than a transcription of it, and a transcription is
 * what was already wrong.
 *
 * Both extractions are anchored narrowly and fail *loudly*: an anchor that no
 * longer matches throws out of this driver rather than quietly measuring
 * something else.
 * ------------------------------------------------------------------ */

process.stdout.write("\ncpctl, against the routes it calls\n");
{
  const source = readFileSync(new URL("../packages/control-plane/scripts/cpctl.ts", import.meta.url), "utf8");

  /*
   * `bodyOf` used to live here and evaluated a named function out of `cpctl.ts`
   * so its body could be driven directly. It is gone with `selfProof`, the only
   * function it was ever pointed at — and its removal is the point worth
   * keeping: it **threw** when the name was missing, at module scope, so
   * deleting that function without deleting this made `pnpm relaycheck` crash on
   * import rather than report a failure. A driver that dies takes its other nine
   * hundred assertions with it.
   */

  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));

  /* -- the two admin credential commands, and their deletion ------------- */

  {
    /*
     * **This block used to drive `selfProof` out of `cpctl.ts` and is gone with
     * it**, and the *order* of that deletion was the hazard worth recording:
     * `bodyOf` throws when the named function is missing, at module scope, so
     * removing `selfProof` from `cpctl.ts` without removing this made
     * `pnpm relaycheck` **crash on import** rather than report a failure. A
     * driver that dies is a driver whose other 900 assertions stop running.
     *
     * What replaces it is the assertion that the capability is really gone.
     * Deleting a route needs proving: nothing else here would notice a route
     * quietly still registered, and "we removed it" is the kind of claim that
     * survives a revert.
     */
    check(
      "cpctl no longer offers to reset somebody's password",
      /case "passwd"/.test(source.slice(source.indexOf("async function admin("))),
      false,
    );
    check(
      "nor to mint somebody a key",
      /case "key"/.test(source.slice(source.indexOf("async function admin("))),
      false,
    );
    check("and its usage says so out loud", source.includes("There is no 'admin passwd' and no 'admin key'"), true);
    /*
     * The invariant, mechanically. `INSERT INTO api_keys` may appear in exactly
     * two files, and the occurrence in `app.ts` must not be on a route that
     * reads an `:id` — that is what "no route issues a credential for an account
     * other than the caller's own" reduces to, and it is the form of the rule
     * that stays true when somebody adds a route next year.
     */
    const appSource = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
    /*
     * The **statement** form, not the bare string: the sentence naming this rule
     * lives in a comment two hundred lines below, and counting prose would make
     * the check fail for having been written down.
     */
    const mints = 'db.prepare("INSERT INTO api_keys';
    check("app.ts mints a key in exactly one place", appSource.split(mints).length - 1, 1);
    const mintAt = appSource.indexOf(mints);
    const routeStart = appSource.lastIndexOf("app.post(", mintAt);
    check(
      "and that place is not a route naming somebody else",
      appSource.slice(routeStart, mintAt).includes('c.req.param("id")'),
      false,
    );
  }

  /* -- what `cpctl sessions --all` prints --------------------------------- */

  {
    /*
     * `DELETE /v1/me/sessions` answers `{revokedCount}` — renamed away from the
     * boolean its two single-session siblings answer with, and carrying its own
     * docblock saying why — and only the browser client followed. `api<T>`
     * casts, so the declared type was a lie the compiler could not catch, and
     * the one command whose entire output *is* the count printed "signed out of
     * undefined session(s)" at the moment somebody is revoking every session
     * because they think a token leaked.
     *
     * cpctl's own template literal, rendered against the body the real route
     * answers with. Three sessions rather than one, so that a revert to the old
     * field name cannot coincidentally read as a plausible number.
     *
     * Anchored on the *call* rather than on the sentence: the comment sitting
     * directly above it quotes the broken output and carries backticks of its
     * own, so `includes("signed out of")` alone would lift `api<T>` out of prose
     * and render that instead.
     */
    const line = source.split("\n").find((text) => text.includes("out(`signed out of"));
    if (line === undefined) throw new Error("cpctl.ts no longer prints a `signed out of` line");
    const template = /`([^`]*)`/.exec(line)?.[1];
    if (template === undefined) throw new Error("cpctl.ts's `signed out of` line is no longer a template literal");
    const render = new Function("body", `return \`${template}\`;`) as (body: unknown) => string;

    const holder = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'cpctl-sessions', 0, ?)").run(holder, now);
    const anonymous = { ip: null, userAgent: null };
    const first = mintSession(db, holder, anonymous);
    mintSession(db, holder, anonymous);
    mintSession(db, holder, anonymous);

    const body = await (
      await send("/v1/me/sessions", { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } })
    ).json();
    check("the route answers a count under the name the browser reads", body, { revokedCount: 3 });
    check("and cpctl prints that count rather than `undefined`", render(body), "signed out of 3 session(s)");
  }
}

/* ------------------------------------------------------------------ *
 * A body too large
 *
 * `bodyLimit`'s default `onError` answers `text/plain` "Payload Too Large",
 * which every client in this system mis-reads: `src/http.ts` types 413 as part
 * of `ErrorStatus` on purpose, `packages/web`'s `ApiError` parses `error.code`,
 * and `cpctl` prints it — so the one refusal a caller most needs to understand
 * would arrive as the one shape none of them can parse.
 *
 * Both limits, because they are two registrations with two numbers and the
 * `onError` has to be on each: the public one guards the two routes above THE
 * LINE, and the authenticated one guards everything below it — which had **no
 * bound at all**, on the reasoning that a caller past the gate has a credential.
 * That is a statement about who is asking and not about how much.
 * ------------------------------------------------------------------ */

process.stdout.write("\na body too large\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const key = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_bulk', 'bulk', 0, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_bulk', ?, ?, ?)").run(
    newId("ak"),
    key.prefix,
    key.hash,
    now,
  );
  const headers = { authorization: `Bearer ${key.key}`, "content-type": "application/json" };
  const envelope = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "no error key",
  ];

  const authenticated = await Promise.resolve(
    app.request("/v1/tokens", { method: "POST", headers, body: JSON.stringify({ machine: "x".repeat(300 * 1024) }) }),
  );
  check("an oversized authenticated body is a 413 in the envelope", await envelope(authenticated), [413, "payload_too_large"]);
  const anonymous = await Promise.resolve(
    app.request("/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "somebody", password: "x".repeat(70 * 1024) }),
    }),
  );
  check("and so is an oversized public one", await envelope(anonymous), [413, "payload_too_large"]);
  // The tighter bound is the public one, so a body between the two has to be
  // refused at the front door and accepted past it — otherwise the two
  // registrations are one number written twice.
  const between = await Promise.resolve(
    app.request("/v1/tokens", { method: "POST", headers, body: JSON.stringify({ machine: "x".repeat(70 * 1024) }) }),
  );
  check("a body the public limit refuses is fine past the gate", await envelope(between), [404, "machine_not_found"]);
}

/* ------------------------------------------------------------------ *
 * The headers an API-only instance sends
 *
 * These sat inside `if (webRoot !== null && existsSync(webRoot))`, at the bottom
 * of `app.ts`, and both halves of that were wrong. An instance with
 * `REEMOAT_CP_WEB=0` — the deployed shape whenever the bundle is served by
 * something else — registered no header middleware at all; and Hono runs the
 * handlers that match a request in the order they were added, so an `app.use("*")`
 * registered *below* every `/v1` route never ran for one, a route handler
 * returning without calling `next()`. The policy reached `serveStatic` and the SPA
 * fallback and nothing else, which is why `/v1/*` JSON went out bare in **both**
 * configurations.
 *
 * So this block passes **no `webRoot`**, which is the configuration the section
 * below cannot cover: everything there builds a `dist/` first, i.e. the one
 * arrangement that already worked. Move the middleware back under the guard, or
 * below the routes, and that section stays green while this one goes red.
 *
 * `nosniff` and `Referrer-Policy` are asserted on a **refusal** as well as on a
 * 200, because they are the two the middleware sets before it looks at the status:
 * the first is about a body a browser might decide is HTML, which includes an
 * error envelope, and the second about a URL that may carry a machine or session
 * id into somebody else's logs.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an API-only instance still sends\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const key = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_hdr', 'hdr', 0, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_hdr', ?, ?, ?)").run(
    newId("ak"),
    key.prefix,
    key.hash,
    now,
  );

  const refused = await Promise.resolve(app.request("/v1/me"));
  check(
    "a refusal with no bundle behind it still carries both",
    [refused.status, refused.headers.get("x-content-type-options"), refused.headers.get("referrer-policy")],
    [401, "nosniff", "no-referrer"],
  );

  const mine = await Promise.resolve(app.request("/v1/me", { headers: { authorization: `Bearer ${key.key}` } }));
  check(
    "and so does an answered one",
    [mine.status, mine.headers.get("x-content-type-options"), mine.headers.get("referrer-policy")],
    [200, "nosniff", "no-referrer"],
  );

  // The other half of the same middleware, and the half that must **not** fire
  // here: the year-long immutable directive is for hashed assets, and a JSON
  // answer is neither under `/assets/` nor `text/html`. A rule keyed on the URL
  // rather than on what was served is how that arm reached `index.html` once.
  check("but no cache directive reaches a JSON answer", mine.headers.get("cache-control"), null);
  check("and no policy is spent on a body that is not a document", mine.headers.get("content-security-policy"), null);
}

/* ------------------------------------------------------------------ *
 * The web client, and what a browser is allowed to keep
 *
 * Everything in `createControlPlaneApp` that serves the UI sits behind
 * `webRoot !== null && existsSync(webRoot)`, and the section above passes no
 * `webRoot` at all — so the static handler, the SPA fallback and the cache
 * middleware in front of them were entered by nothing, in any driver. This one
 * builds a `dist/` shaped like Vite's (an `index.html` plus one hash-named
 * chunk under `assets/`) in a `tmp()` directory and drives the same app
 * against it, offline, through `app.request()`.
 *
 * Both things being pinned here have a production incident behind them and
 * neither is visible from the server:
 *
 *   - With no `Cache-Control` and no validator a browser caches *heuristically*
 *     — it may serve `index.html` from disk for as long as it likes without
 *     asking. That page names hashed chunks the browser also holds, so it never
 *     404s and never notices; it simply keeps running a build the server has
 *     already deleted. Diagnosed by deploying a fix, fetching the served bundle
 *     to confirm it was there, and watching the reporter reload into the old app
 *     anyway. Every check said the server was right, and the server was right.
 *
 *   - `/` and every client-side route must serve the *same file from disk, per
 *     request*. When the fallback held a `readFileSync` copy taken at
 *     registration, `pnpm web:build` under a running control plane made the two
 *     disagree: `/` streamed the new HTML naming the new chunks while
 *     `/m/:machine/s/:session` returned the old HTML naming chunks Vite had
 *     deleted — measured 2026-08-01, `index-BnlrEjly.js` against
 *     `index-0vnvikLW.js`, and the second answered 404. So the home screen
 *     worked and reloading on a session gave a blank white page, on a phone with
 *     no console. That is why the rebuild below happens *between* two requests
 *     rather than before them: comparing two responses taken from an unchanged
 *     directory cannot tell a stream from a cached copy.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe web client, and what may be cached\n");
{
  const webRoot = tmp("relaycheck-web-");
  mkdirSync(join(webRoot, "assets"));

  const chunk = 'console.log("the bundle");\n';
  writeFileSync(join(webRoot, "assets", "index-abc123.js"), chunk);

  /*
   * And one over `COMPRESS_MIN_BYTES`, because the gzip path only runs past it and
   * **this is the combination that broke production**: `serveStatic` sets its own
   * `content-length`, and Hono's `set res` merges the previous response's headers
   * onto the replacement — so the uncompressed length won and the wire carried a
   * gzip body under it. `content-encoding` and `vary` arrived, which is why it read
   * as correct. A browser drops such a response in silence: a white page, empty
   * console.
   */
  const bundle = `${'console.log("the bundle");\n'.repeat(600)}//# sourceMappingURL=index.js.map\n`;
  writeFileSync(join(webRoot, "assets", "index-big.js"), bundle);

  // Two builds of the same page, distinguishable byte-for-byte, because the
  // only way to catch a cached copy is to change the file underneath it.
  const buildOne = '<!doctype html><title>one</title><div id="root"></div><script src="/assets/index-abc123.js"></script>\n';
  const buildTwo = '<!doctype html><title>two</title><div id="root"></div><script src="/assets/index-def456.js"></script>\n';
  writeFileSync(join(webRoot, "index.html"), buildOne);

  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relayUrls: { "relay-2": "https://r2.example" },
    relay: registry,
    webRoot,
  });

  /*
   * ⭐ **The bundle went out gzipped under the *uncompressed* length, and two of
   * its three headers were right.**
   *
   * The assertion that existed drove a `c.json` route, where there is no
   * `content-length` for the merge to bring back — so it passed while the one path
   * that has one was broken. This one goes through `serveStatic`, which is where it
   * happened, and the load-bearing line is the second: the length must describe the
   * bytes on the wire and nothing else.
   */
  {
    const res = await Promise.resolve(
      app.request("/assets/index-big.js", { headers: { "accept-encoding": "gzip" } }),
    );
    const sent = Buffer.from(await res.arrayBuffer());
    check("an asset worth compressing is compressed", res.headers.get("content-encoding"), "gzip");
    check("and its length is the length of what was sent", res.headers.get("content-length"), String(sent.byteLength));
    check("which is not the length of the file", res.headers.get("content-length") !== String(bundle.length), true);
    check("and it decompresses to the file", gunzipSync(sent).toString("utf8"), bundle);
  }

  /*
   * **The policy has to name every relay a browser can be sent to.**
   *
   * ⚠ It was built from `relayUrl` alone, which was the whole truth while there
   * was one relay and became a blocker the moment `relayUrlFor` could answer
   * with something else: the document says `connect-src … relay.example`, the
   * token says go to `r2.example`, and the browser refuses its own request
   * before a byte leaves. `machine.ts` probes with `fetch`, catches, and settles
   * `no_route` — there is no HTTP status, so `forgetRoute` never fires and
   * re-probing cannot recover. A machine permanently offline with no error text,
   * which is strictly worse than the one-in-N `503` the routing exists to
   * remove.
   *
   * Asserted on `/` because the CSP rides the *document* — a policy on a JS
   * response governs nothing.
   */
  {
    const csp = (await Promise.resolve(app.request("/"))).headers.get("content-security-policy") ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    // `relayUrl` here is this driver's own loopback listener, so the pair is
    // derived from it rather than written out — the property is "both schemes
    // of the default", not a particular host.
    const base = new URL(relayUrl);
    check("the policy names the default relay, both schemes", [
      connect.includes(base.origin),
      connect.includes(`ws://${base.host}`),
    ], [true, true]);
    check("and every relay in the routing map, or it blocks its own routing", [
      connect.includes("https://r2.example"),
      connect.includes("wss://r2.example"),
    ], [true, true]);

    /*
     * An instance with no catalogue names neither market host, which is exactly
     * what such an instance can reach — `connectOrigins`' posture one value over.
     * Asserted rather than assumed, because the alternative to "absent" here is a
     * policy that quietly widens for every deployment in the fleet, market or no.
     */
    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? "";
    check(
      "an instance with no catalogue names neither market host, in either directive",
      [connect.includes("raw.githubusercontent.com"), img.includes("raw.githubusercontent.com")],
      [false, false],
    );
    /*
     * ⚠ **And the one third-party source that is *not* conditional on anything.**
     * Every instance compiles in the same table of systems, so every instance's
     * model picker reads OpenRouter's catalogue straight from the browser —
     * `packages/web/src/openrouter.ts` says why the daemon does not proxy it.
     * Asserted here, in the block about an instance with *nothing* configured,
     * because that is precisely where a source that depends on a setting would
     * have gone missing. Omit it and the section never fills, with the reason only
     * in a console nobody has open on a phone.
     *
     * `connect-src` alone: this reads JSON and draws no icon, which is the
     * distinction the market's own pair exists to teach.
     */
    check(
      "and the one model catalogue the picker reads, on an instance with nothing configured",
      [connect.includes("https://openrouter.ai"), img.includes("openrouter.ai")],
      [true, false],
    );
  }

  /*
   * ⚠ **The market needs three sources across *two* directives, and the pair is
   * the assertion.**
   *
   * A plugin's `plugin.json` is read with `fetch` and its icon is drawn with
   * `<img src>`, and CSP treats those as different questions. Listing
   * `raw.githubusercontent.com` in `connect-src` alone is the failure mode that
   * reads as working: every permission list on the market screen renders
   * correctly, and every icon is silently blank — with the reason only in a
   * console, on a phone, where nobody has one open. So this checks all three
   * sources in the directive each belongs to, and it checks the icon host is in
   * *both*.
   *
   * A separate app rather than a field on the one above, because the assertion
   * immediately preceding this one is that an instance without a catalogue names
   * none of them.
   */
  {
    const withMarket = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      webRoot,
      pluginCatalogueUrl: "https://plugins.example",
    });
    const csp = (await Promise.resolve(withMarket.request("/"))).headers.get("content-security-policy") ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? "";
    check(
      "a catalogue is reachable, and so is the host its manifests and icons come from",
      [
        connect.includes("https://plugins.example"),
        connect.includes("https://raw.githubusercontent.com"),
        img.includes("https://raw.githubusercontent.com"),
        // Still there beside the market's three, which is the half a conditional
        // source would break: the market widens `connect-src` by string
        // concatenation, and a mistake there drops whatever it was appended to.
        connect.includes("https://openrouter.ai"),
      ],
      [true, true, true, true],
    );
    /*
     * The origin, never the path somebody configured — CSP matches origins, and a
     * source with a path in it is one browsers treat differently from what the
     * writer meant.
     */
    const deep = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      webRoot,
      pluginCatalogueUrl: "https://plugins.example/api/v2/",
    });
    const deepCsp = (await Promise.resolve(deep.request("/"))).headers.get("content-security-policy") ?? "";
    check(
      "and it is listed as an origin rather than as the path it was configured with",
      /connect-src ([^;]+)/.exec(deepCsp)?.[1]?.includes("https://plugins.example/api") ?? true,
      false,
    );
    /*
     * A value `fetch` could never use reaches the same policy an absent one does.
     * `main.ts` warns about it; the app's own answer must not be a throw at
     * construction, because a driver may build an app with anything.
     */
    const nonsense = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      webRoot,
      pluginCatalogueUrl: "not a url",
    });
    const nonsenseCsp = (await Promise.resolve(nonsense.request("/"))).headers.get("content-security-policy") ?? "";
    check(
      "an unparseable catalogue widens nothing",
      (/img-src ([^;]+)/.exec(nonsenseCsp)?.[1] ?? "").includes("raw.githubusercontent.com"),
      false,
    );

    /*
     * What the client is told, and why publishing the address is safe: it is the
     * same value the document's own `connect-src` already carries, read once at
     * construction, so a client cannot be handed a catalogue the page may not
     * reach.
     */
    const instance = (await Promise.resolve(withMarket.request("/v1/instance"))) as Response;
    const told = (await instance.json()) as { plugins?: { catalogue?: unknown } };
    check("and /v1/instance says where it is", told.plugins?.catalogue, "https://plugins.example");
    const without = (await Promise.resolve(app.request("/v1/instance"))) as Response;
    const silent = (await without.json()) as { plugins?: { catalogue?: unknown } };
    check("while an instance with none says so rather than omitting the field", silent.plugins?.catalogue, null);
  }

  interface WebResponse {
    status: number;
    cacheControl: string | null;
    body: string;
  }
  const get = async (path: string): Promise<WebResponse> => {
    const response = await Promise.resolve(app.request(path));
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: await response.text(),
    };
  };

  // A client-side route: three segments the router knows nothing about, which is
  // the shape that used to come back as a blank page on reload.
  const sessionRoute = "/m/m_mine/s/s_abc123";

  const root = await get("/");
  check("the index is served at /", { status: root.status, body: root.body }, { status: 200, body: buildOne });
  /*
   * `no-cache`, and the exact string matters in both directions.
   *
   * It is not `no-store`: the instruction is *revalidate before use*, so once a
   * validator exists a 304 still costs nothing, and this file is 1.5 KiB against
   * being the one request that decides which build a client runs. And it is not
   * absent, which is what heuristic caching needs to take over.
   */
  check("and it revalidates before use", root.cacheControl, "no-cache");

  const asset = await get("/assets/index-abc123.js");
  check("a hashed chunk is served", { status: asset.status, body: asset.body }, { status: 200, body: chunk });
  /*
   * The opposite directive, safe for exactly the reason it is needed: the
   * filename contains a hash of the contents, so the URL cannot outlive the
   * bytes. `immutable` is what stops a reload re-fetching half a megabyte of
   * JavaScript over LTE.
   */
  check("and is kept for a year, immutably", asset.cacheControl, "public, max-age=31536000, immutable");

  const route = await get(sessionRoute);
  check("a client-side route reaches the SPA fallback", route.status, 200);
  // Byte-identical to `/`, not merely "some HTML". This is the invariant the
  // blank-white-page incident broke, and the two ways of reaching one page
  // disagreeing is the worst shape it can have.
  check("and serves the identical bytes / does", route.body, root.body);
  check("and carries the same directive as /", route.cacheControl, root.cacheControl);

  /*
   * A rebuild under the running process. `pnpm web:build` rewrites `dist/` and
   * nothing restarts the control plane, so "from disk, per request" is the whole
   * property — a fallback holding a copy taken at registration passes every
   * assertion above and fails both of these.
   */
  writeFileSync(join(webRoot, "index.html"), buildTwo);
  const rebuiltRoot = await get("/");
  const rebuiltRoute = await get(sessionRoute);
  check("a rebuild under the running process reaches /", rebuiltRoot.body, buildTwo);
  check("and reaches the fallback too, from disk", rebuiltRoute.body, buildTwo);

  /*
   * A hashed chunk that is not there. `looksLikeAsset` refuses it a page of HTML
   * — a stale `index.html` in a phone's cache asks for a chunk a rebuild has
   * removed, and answering 200 turns the 404 that would tell it to reload into a
   * MIME type error — and the middleware's `status !== 200` guard is what keeps
   * that 404 out of the cache. A cached 404 for a hashed chunk is the deployment
   * gone: the browser stops asking, on the one URL that can never come back.
   */
  const missing = await get("/assets/index-deadbeef.js");
  check("a missing hashed chunk is a 404", missing.status, 404);
  check("and a non-200 is never given a cache directive", missing.cacheControl, null);

  /*
   * The API is untouched — and **what keeps it untouched is the content-type
   * guard, not registration order**, which is worth writing down because this
   * comment said the opposite and the opposite was measured to be false.
   *
   * The claim was that `/v1/jwks` is registered before this `app.use("*")` and so
   * never reaches it, and that a tidying refactor moving the registration would
   * therefore break the API. Driven: hoisting the middleware above every `/v1`
   * route leaves this case **green**, because `jwks` answers with `c.json(...)`
   * and neither arm of the middleware matches `application/json` on a path
   * outside `/assets/`. So the ordering is not what is being relied on.
   *
   * That makes this case a weak one and it is kept deliberately rather than
   * deleted: it is a boundary marker saying an API response carries no cache
   * directive, which is a fact worth stating even though no single edit to the
   * middleware reddens it alone. The mutation that *does* redden it — setting a
   * directive unconditionally, before any guard — is real, and is the shape a
   * careless "just cache everything static" change takes.
   */
  const api = await get("/v1/jwks");
  check("an API response is unaffected", { status: api.status, cacheControl: api.cacheControl }, { status: 200, cacheControl: null });

  /*
   * A RECORDED DEFECT, asserted as it currently behaves so that fixing it turns
   * this line red rather than leaving it to be discovered again.
   *
   * The middleware tests `/assets/` *before* it tests the content type, and
   * `looksLikeAsset` requires an extension (`/\.[a-zA-Z0-9]{1,8}$/`). So an
   * extensionless path under `/assets/` misses `serveStatic`, misses the
   * fallback's asset refusal, is answered with `index.html` at 200 — and is then
   * handed `public, max-age=31536000, immutable` on the exact file the whole
   * middleware exists to keep fresh. A browser that once loads such a URL is
   * pinned to that build for a year with no way to ask.
   *
   * The correct answer is `no-cache`: the immutable directive belongs to a
   * response whose *bytes* came from a hashed filename, not to a path that
   * merely looks like one. Measured against this driver, swapping the two
   * branches so the content type is tested first fixes it and leaves every other
   * case in this section green — so the fix is a reorder, and whoever makes it
   * should flip the `want` on the second line below to "no-cache" and delete
   * this comment rather than go looking for what else it broke.
   */
  const extensionless = await get("/assets/foo");
  check("an extensionless path under /assets/ is a 404, not a page of HTML", extensionless.status, 404);
  check("and carries no cache directive at all", extensionless.cacheControl, null);

  /*
   * The **second** answer to the same defect, asserted separately because the two
   * are independent and either alone would have prevented it.
   *
   * The fallback refusing the whole `/assets/` namespace is what makes the case
   * above a 404. The middleware asking what was *served* rather than what was
   * *asked for* is what makes an HTML body unable to take the immutable arm from
   * any URL whatsoever. So this drives the middleware directly, against a path
   * under `/assets/` that really does return HTML — which is exactly what the old
   * fallback produced — by serving `index.html` through a route registered for
   * it. If somebody later relaxes the fallback's refusal, this stays red.
   */
  writeFileSync(join(webRoot, "assets", "probe.html"), "<!doctype html><title>probe</title>\n");
  const htmlUnderAssets = await get("/assets/probe.html");
  check("an HTML file under /assets/ really is served", htmlUnderAssets.status, 200);
  check("but it revalidates rather than being kept for a year", htmlUnderAssets.cacheControl, "no-cache");

  // Ours, made by `tmp()` two hundred lines up and holding nothing but the four
  // fixture bytes above. Removed here rather than left to `sweepTmp`'s handler on
  // exit because the rest of this file runs after it and a stale `dist/` on disk
  // is exactly the thing a later case must not be able to serve from; the sweep
  // still lists it, and `force` makes the second removal a no-op.
  rmSync(webRoot, { recursive: true, force: true });
}

process.stdout.write("\nlosing the tunnel\n");
{
  await tunnel.stop();
  await sleep(300);
  check("the machine is reported offline", registry.isOnline(mine), false);

  const refused = await relayFetch("/sessions", tokenFor(alice, mine));
  check("requests fail fast rather than queueing", refused.status, 503);
  check("with a code that says which kind of unreachable", JSON.parse(refused.body).error.code, "no_tunnel");

  // Back up again, on a fresh tunnel, with no state carried over.
  const again = RelayTunnel.start({
    relayUrl,
    tunnelKey: myTunnelKey,
    local: { host: "127.0.0.1", port: daemonPort },
  });
  check("a daemon can reconnect", await waitForTunnel(mine), true);
  check("and serve again", (await relayFetch("/sessions", tokenFor(alice, mine))).status, 200);
  await again.stop();
}

process.stdout.write("\na daemon that takes the stream and never answers\n");
{
  /*
   * ⚠ **There was no bound on this at all.** A tunnel that accepts a CONNECT and
   * then says nothing held the browser until its own socket closed, and held one
   * of `MAX_CONCURRENT_STREAMS` on that tunnel for the same length of time —
   * which for a daemon wedged behind a stalled filesystem call is until somebody
   * restarts it. Nothing else covered it: `res.on("close")` fires when the
   * *client* gives up, and the tunnel's ping tick proves the socket is alive,
   * which is exactly the state this is about.
   *
   * Built out of a listener that accepts and writes nothing, which is what a
   * wedged daemon looks like from here — not a closed port, which the existing
   * `tunnel_failed` path already covers, and not a slow one.
   *
   * `upstreamTimeoutMs` is a seam for the same reason `SmtpDialer` is one: the
   * real number is two minutes, and a driver that spent two minutes to watch it
   * would not assert it at all.
   */
  const silent = netCreateServer(() => {
    // Accept and hold. Deliberately no response, no FIN, no reset.
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const silentPort = (silent.address() as AddressInfo).port;

  const impatient = new TunnelRegistry();
  const impatientListener = createRelayListener({
    db,
    issuer: ISSUER,
    host: "127.0.0.1",
    port: 0,
    registry: impatient,
    upstreamTimeoutMs: 200,
  });
  await listening(impatientListener.server);
  const impatientUrl = `http://127.0.0.1:${(impatientListener.server.address() as AddressInfo).port}`;

  const wedged = RelayTunnel.start({
    relayUrl: impatientUrl,
    tunnelKey: myTunnelKey,
    local: { host: "127.0.0.1", port: silentPort },
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !impatient.isOnline(mine)) await sleep(25);
  check("the wedged daemon's tunnel is up", impatient.isOnline(mine), true);

  const started = Date.now();
  const held = await fetch(new URL("/sessions", impatientUrl), {
    headers: { authorization: `Bearer ${tokenFor(alice, mine)}` },
  });
  const waited = Date.now() - started;
  check("a request it never answers is given up on", held.status, 502);
  check(
    "and reported as the tunnel failing rather than as a new kind of error",
    ((await held.json()) as { error: { code: string } }).error.code,
    "tunnel_failed",
  );
  report("rather than held until the client gives up", waited < 3_000, `${waited}ms`);

  await wedged.stop();
  impatientListener.close();
  silent.close();
}

relayListener.close();
daemon.close();

/* ------------------------------------------------------------------ *
 * The SMTP client, against a server made of two PassThroughs
 *
 * `sendMessage` takes an `SmtpDialer` rather than opening a socket, for the
 * reason `AcpClient` takes an `AgentProcess` rather than spawning: it is the
 * only way a driver reaches the states that matter. The fake below records
 * **every command line** the client wrote, in order, which is what turns four
 * properties from "it threw" into assertions:
 *
 *   - a refused downgrade is only a defence if it happens *before* AUTH and
 *     MAIL FROM. A case that asserts the throw alone is green while the
 *     credential and the recipient went out in the clear first.
 *   - the second EHLO winning is invisible from the outside, because a server
 *     that advertises AUTH twice makes both implementations work. It is only
 *     observable against one that advertises it *once*, after TLS.
 *   - the QUIT rule is the one place a careful implementation sends the message
 *     twice, and its symptom is somebody receiving two password-reset links.
 *   - whether a failure is *permanent* is what `recordMailFailure` branches on,
 *     so getting it wrong is eight retries over four hours against a server that
 *     has already said no, or one attempt at a message that was merely unlucky.
 *
 * A library would have made all four "asserted by having been imported", and the
 * fifth case below — a TLS handshake that never settles — is not reachable with
 * one at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe SMTP client, against a fake server\n");
{
  interface FakeSmtpOptions {
    /** Capability lines per EHLO, in order. The last is reused if asked again. */
    ehlo: string[][];
    /** Replies that override the default, keyed by the start of the command. */
    refuse?: Record<string, string>;
    /** Handed the ordinary upgrade, so a case can decline to settle at all. */
    startTls?: (upgrade: () => Duplex) => Promise<Duplex | null>;
    /** Cut the connection instead of answering QUIT. */
    quitCuts?: boolean;
  }

  interface FakeSmtp {
    dialer: SmtpDialer;
    /** Command lines only — the DATA body is not commands and is not here. */
    written: string[];
  }

  /**
   * A server that answers a script and remembers what it was asked.
   *
   * Two `PassThrough`s joined by `Duplex.from`, rather than one: a single
   * PassThrough echoes the client's own writes back at its reader, so
   * `ReplyReader` would parse `EHLO` as a reply to itself. The EHLO counter is
   * **shared across the upgrade**, which is what lets one script say "STARTTLS
   * only, then AUTH only".
   */
  const fakeSmtp = (options: FakeSmtpOptions): FakeSmtp => {
    const written: string[] = [];
    const open: PassThrough[] = [];
    let ehloAt = 0;
    /*
     * Where an `AUTH LOGIN` exchange has got to: 0 none, 1 expecting the
     * username, 2 expecting the password. Shared across the upgrade like
     * `ehloAt`, and the reason it is state rather than three `refuse` entries is
     * that what the two continuation lines carry is *base64 of the credential* —
     * a script keyed on those strings would be asserting the answer by having
     * written it into the question.
     */
    let loginAt = 0;

    const answer = (line: string): string => {
      const upper = line.toUpperCase();
      for (const [prefix, reply] of Object.entries(options.refuse ?? {})) {
        if (upper.startsWith(prefix.toUpperCase())) return `${reply}\r\n`;
      }
      if (loginAt > 0) {
        const step = loginAt;
        loginAt = step === 1 ? 2 : 0;
        return step === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 2.7.0 authenticated\r\n";
      }
      if (upper === "AUTH LOGIN") {
        loginAt = 1;
        return "334 VXNlcm5hbWU6\r\n";
      }
      if (upper.startsWith("EHLO")) {
        const caps = options.ehlo[Math.min(ehloAt, options.ehlo.length - 1)] ?? [];
        ehloAt += 1;
        // Multiline: continuation lines are `250-` and the last is `250` with a
        // space. That one character is the terminator the reader keys on.
        const lines = ["fake.example greets you", ...caps];
        return lines.map((text, index) => `250${index === lines.length - 1 ? " " : "-"}${text}\r\n`).join("");
      }
      if (upper.startsWith("STARTTLS")) return "220 2.0.0 ready to start TLS\r\n";
      if (upper.startsWith("AUTH")) return "235 2.7.0 authenticated\r\n";
      if (upper.startsWith("DATA")) return "354 go ahead\r\n";
      if (upper.startsWith("QUIT")) return "221 2.0.0 bye\r\n";
      return "250 2.0.0 ok\r\n";
    };

    const socket = (greeting: string | null): Duplex => {
      const toClient = new PassThrough();
      const fromClient = new PassThrough();
      open.push(toClient, fromClient);
      let buffer = "";
      let inData = false;
      fromClient.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const at = buffer.indexOf("\r\n");
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (inData) {
            // Nothing inside the body is a command; only the lone dot ends it.
            if (line === ".") {
              inData = false;
              toClient.write("250 2.0.0 queued\r\n");
            }
            continue;
          }
          written.push(line);
          if (options.quitCuts === true && line.toUpperCase().startsWith("QUIT")) {
            toClient.destroy(new Error("connection reset by peer"));
            continue;
          }
          if (line.toUpperCase().startsWith("DATA")) inData = true;
          toClient.write(answer(line));
        }
      });
      if (greeting !== null) toClient.write(greeting);
      return Duplex.from({ readable: toClient, writable: fromClient });
    };

    const upgrade = (): Duplex => socket(null);
    const handshake = options.startTls ?? ((make: () => Duplex): Promise<Duplex | null> => Promise.resolve(make()));

    return {
      written,
      dialer: {
        connect(): Promise<SmtpConnection> {
          return Promise.resolve({
            stream: socket("220 fake.example ESMTP\r\n"),
            startTls: () => handshake(upgrade),
            close(): void {
              for (const stream of open) stream.destroy();
            },
          });
        },
      },
    };
  };

  const deliver = (
    dialer: SmtpDialer,
    over: {
      security?: "implicit_tls" | "starttls" | "plaintext";
      auth?: "plain" | "login" | "none";
      username?: string | null;
      password?: string | null;
      timeouts?: Partial<Record<keyof typeof SMTP_TIMEOUTS, number>>;
    } = {},
  ): Promise<void> =>
    sendMessage(
      {
        host: "fake.example",
        port: 587,
        security: over.security ?? "starttls",
        auth: over.auth ?? "none",
        username: over.username ?? null,
        password: over.password ?? null,
        rejectUnauthorized: true,
        ehloName: "[127.0.0.1]",
        dialer,
        timeouts: over.timeouts,
      },
      { from: "bot@fake.example", to: "ada@example.com", message: "Subject: hi\r\n\r\nbody\r\n" },
    );

  /** The `SmtpError` a delivery failed with, or `null` when it did not fail. */
  const refusal = async (work: Promise<void>): Promise<SmtpError | null> => {
    try {
      await work;
      return null;
    } catch (error) {
      return error instanceof SmtpError ? error : new SmtpError("body", `not an SmtpError: ${String(error)}`);
    }
  };

  /* -- no silent downgrade ---------------------------------------------- */

  {
    const fake = fakeSmtp({ ehlo: [["SIZE 10240000"]] });
    const failure = await refusal(deliver(fake.dialer, { auth: "plain", username: "u", password: "p" }));
    check("a server that does not offer STARTTLS is refused at the right step", failure?.step, "starttls");
    /*
     * **The half that would still be green with the credential already sent.**
     * Asserted as the whole transcript rather than as an absence, because a
     * predicate over a list is only as good as the names in it — and then again
     * *as* that predicate, because naming AUTH and MAIL FROM is what says which
     * two lines this refusal exists to prevent.
     */
    check("and nothing at all was written past the EHLO", fake.written, ["EHLO [127.0.0.1]"]);
    check(
      "so no credential and no recipient reached a cleartext wire",
      fake.written.some((line) => /^(AUTH|MAIL FROM)/i.test(line)),
      false,
    );
  }

  /* -- the second EHLO wins ---------------------------------------------- */

  {
    // The shape that tells the two implementations apart: AUTH is advertised
    // **only** after the upgrade, which is what careful servers do.
    const fake = fakeSmtp({ ehlo: [["STARTTLS"], ["AUTH PLAIN"]] });
    const failure = await refusal(deliver(fake.dialer, { auth: "plain", username: "u", password: "p" }));
    report(
      "a server advertising AUTH only after TLS is authenticated against",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    const secondEhlo = fake.written.lastIndexOf("EHLO [127.0.0.1]");
    const auth = fake.written.findIndex((line) => line.toUpperCase().startsWith("AUTH"));
    // Ordering, not membership: a client reusing the pre-TLS list would refuse
    // with `does not offer AUTH PLAIN` and never write this line at all.
    report(
      "and the AUTH followed the second EHLO rather than the first",
      secondEhlo > 0 && auth > secondEhlo,
      fake.written.join(" · "),
    );
  }

  /* -- QUIT is politeness, never delivery -------------------------------- */

  {
    const fake = fakeSmtp({ ehlo: [["STARTTLS"], []], quitCuts: true });
    const failure = await refusal(deliver(fake.dialer));
    /*
     * The message is delivered the moment the server answers 250 to the final
     * dot. Treating what happens afterwards as a failure means the outbox retries
     * a message the server already accepted, and somebody receives two
     * password-reset links — the one place a careful implementation double-sends.
     */
    report(
      "a QUIT that dies after the final 250 is not a failed send",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    check("and the QUIT really was attempted", fake.written.includes("QUIT"), true);
  }

  /* -- permanent, or merely now ------------------------------------------ */

  {
    /*
     * `recordMailFailure` branches on exactly this, so the two answers decide
     * whether a row is retried eight times over four hours or given up on at
     * once. A 5xx will be refused the same way in an hour; a transport failure
     * says nothing about the message.
     */
    const refused = fakeSmtp({
      ehlo: [["STARTTLS"], []],
      refuse: { "MAIL FROM": "550 5.1.8 sender address not allowed" },
    });
    const permanent = await refusal(deliver(refused.dialer));
    check(
      "a 5xx on MAIL FROM is permanent",
      [permanent?.step, permanent?.code, permanent?.permanent],
      ["mail_from", 550, true],
    );
    const unreachable = await refusal(
      deliver({ connect: () => Promise.reject(new Error("ECONNREFUSED")) }),
    );
    check(
      "and a host that cannot be reached at all is not",
      [unreachable?.step, unreachable?.code, unreachable?.permanent],
      ["connect", null, false],
    );
  }

  /* -- the handshake that never settles ---------------------------------- */

  {
    /*
     * **The one await in `sendMessage` that used to have no deadline**, and the
     * reason it is worth a case of its own: every other step is bounded by
     * `ReplyReader` asking for bytes, and `total` is only re-checked *at* a read,
     * so a TLS negotiation that stalls is invisible to both. It does not merely
     * lose one message — `outbox.ts` clears its `running` flag in a `finally`, so
     * an unsettling handshake retires the fleet's only mail pump for the life of
     * the process, silently.
     */
    const stuck = fakeSmtp({
      ehlo: [["STARTTLS"], []],
      startTls: () => new Promise<Duplex | null>(() => undefined),
    });
    const started = Date.now();
    /*
     * Raced in the driver rather than merely timed, because the failure this
     * guards against is an await that never settles — and a case that waited for
     * one would hang `pnpm relaycheck` instead of reddening a line, which is the
     * one way a regression here could go unnoticed twice.
     */
    const outcome = await Promise.race([
      refusal(deliver(stuck.dialer, { timeouts: { handshake: 50, total: 5_000 } })).then(
        (error) => error?.step ?? "delivered",
      ),
      sleep(1_000).then(() => "never settled"),
    ]);
    report(
      "a TLS handshake that never settles is bounded rather than wedging the pump",
      outcome === "starttls",
      `${outcome} after ${Date.now() - started}ms`,
    );
  }

  /* -- AUTH LOGIN, which is three round trips rather than one ------------- */

  {
    /*
     * **Every case above this is `AUTH PLAIN`**, which is one line and therefore
     * says nothing about the mechanism that has an *order*. LOGIN is a
     * challenge-response: the client sends `AUTH LOGIN`, is asked for a
     * username, answers, is asked for a password, answers. Sending them the
     * other way round works against nothing and fails identically to a wrong
     * password — `535` — so it is diagnosed as somebody's credential being wrong
     * rather than as this client being wrong.
     *
     * Asserted as the three lines in sequence, and by *value*: the second is
     * base64 of the username and the third base64 of the password, so a
     * transposition is caught rather than merely a missing line. `expect(300)`
     * on the first two is the other half — a client reading the 334 challenges
     * as ordinary 250s would send the password to a server that never asked.
     */
    const fake = fakeSmtp({ ehlo: [["STARTTLS"], ["AUTH LOGIN"]] });
    const failure = await refusal(
      deliver(fake.dialer, { auth: "login", username: "ada@example.com", password: "a mailbox password" }),
    );
    report(
      "a server offering only AUTH LOGIN is authenticated against",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    const at = fake.written.findIndex((line) => line.toUpperCase().startsWith("AUTH"));
    check("and the exchange is the command, then the name, then the secret", fake.written.slice(at, at + 3), [
      "AUTH LOGIN",
      Buffer.from("ada@example.com", "utf8").toString("base64"),
      Buffer.from("a mailbox password", "utf8").toString("base64"),
    ]);
    // The credential is never on the AUTH line itself under LOGIN, which is the
    // one difference between the two mechanisms a log-scraping operator sees.
    check("the password is never on the command line", /AUTH LOGIN .+/.test(fake.written[at] ?? ""), false);
  }

  /* -- implicit TLS, where there is no STARTTLS to write ------------------- */

  {
    /*
     * Port 465: the socket is encrypted before the greeting, so there is no
     * upgrade and **only one EHLO**. Two things are worth asserting rather than
     * assuming, because both are ways this arm silently becomes the other one: a
     * client that writes `STARTTLS` anyway gets `500 command unrecognized` from
     * a server that is already encrypted, and a client that reuses the
     * starttls branch's "discard the first capability list" logic would go
     * looking for a second EHLO that never happens.
     */
    const fake = fakeSmtp({ ehlo: [["AUTH PLAIN"]] });
    const failure = await refusal(
      deliver(fake.dialer, { security: "implicit_tls", auth: "plain", username: "u", password: "p" }),
    );
    report(
      "an already-encrypted connection delivers",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    check("with no STARTTLS written at all", fake.written.includes("STARTTLS"), false);
    check("one EHLO rather than two", fake.written.filter((line) => line.startsWith("EHLO")).length, 1);
    check(
      "and the credential still went, on the capabilities of that single EHLO",
      fake.written.includes(`AUTH PLAIN ${Buffer.from("\0u\0p", "utf8").toString("base64")}`),
      true,
    );
  }

  /* -- a password over a connection that was never encrypted --------------- */

  {
    /*
     * `plaintext` is for a loopback dev MTA, which wants no credential;
     * configuring both is a contradiction, and it is caught **here** rather than
     * on the wire. The transcript is the assertion for the same reason the
     * downgrade case gives: a refusal that happened after the `AUTH` line would
     * be green on the step alone while the mailbox password had already been
     * sent in the clear to an admin-supplied host.
     */
    const fake = fakeSmtp({ ehlo: [["AUTH PLAIN"]] });
    const failure = await refusal(
      deliver(fake.dialer, { security: "plaintext", auth: "plain", username: "u", password: "p" }),
    );
    check("a password over an unencrypted connection is refused at auth", failure?.step, "auth");
    check("and nothing past the EHLO was written", fake.written, ["EHLO [127.0.0.1]"]);
    // Not permanent: the remedy is a settings change, and a row that gave up
    // would be one an operator has to notice and re-queue by hand.
    check("and the refusal is ours rather than a server's", [failure?.code, failure?.permanent], [null, false]);
  }

  /* -- a server's words, made safe to store and to render ------------------ */

  {
    /*
     * Every `SmtpError.reply` runs through this, and the string lands in
     * `mail_outbox.last_error`, which the admin delivery screen draws and
     * nothing else escapes. The host is admin-supplied, so the "server" may be
     * anything at all: a newline there is a log entry somebody else wrote, and
     * an unbounded reply is a settings form that can grow a database column.
     */
    check("CR, LF and tabs collapse to one space", sanitizeReply("550 no\r\n\tand no"), "550 no and no");
    check("other control characters go entirely", sanitizeReply("550 \x00\x07ok\x7f"), "550 ok");
    check("and the result is trimmed", sanitizeReply("  \r\n 550 ok \r\n "), "550 ok");
    const long = sanitizeReply("x".repeat(1000));
    // 300 characters and an ellipsis, so a truncation is visible rather than a
    // reply that merely looks short.
    check("an over-long reply is truncated visibly", [long.length, long.endsWith("…")], [301, true]);
  }
}

/* ------------------------------------------------------------------ *
 * The SMTP client, over a real TLS socket
 *
 * Everything above drives `sendMessage` through a fake dialer, which is what
 * makes the STARTTLS ordering and the QUIT rule assertable at all — and it
 * means `socketDialer()`, the only outbound socket this package has, was
 * executed by **nothing**. The fake's `startTls` hands back a fresh
 * `PassThrough`, so `tls.connect` was never called: SNI, certificate handling
 * and the whole implicit-TLS (port 465) path were unreached code.
 *
 * The defect that earns the case is `sniFor`. Node refuses an IP as
 * `servername` — *"Setting the TLS ServerName to an IP address is not
 * permitted"*, thrown out of `tls.connect` before a byte moves — so passing
 * `smtp.host` straight through made **every** message on an IP-addressed relay
 * fail for ever, and a docker gateway or an internal MTA is a thing operators
 * really type. It was disguised twice over: the throw is not an `SmtpError`, so
 * `sendMessage`'s wrapper files it under step `body` for a connection that died
 * at the handshake, and `permanent` is false, so every message burned all eight
 * attempts against a host that was never dialled.
 *
 * **Both hosts are driven, and the pair is the point.** `localhost` is a legal
 * SNI name and delivers with the defect in place, so an arm on it alone proves
 * TLS works and nothing about the bug; `127.0.0.1` is the arm that goes red.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe SMTP client, over a real TLS socket\n");
{
  /*
   * **A loopback test fixture, deliberately committed.** Generated once, by
   * hand, and pasted here:
   *
   *   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
   *     -subj "/CN=localhost" -keyout key.pem -out cert.pem \
   *     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
   *
   * Embedded rather than shelled out for at run time, because `openssl` is not
   * a dependency of this repository and a driver that skips itself where a
   * binary is absent is a driver that is green on the one machine that has it.
   * It expires in 2126, it signs nothing, nothing trusts it, and the only thing
   * that ever presents it is a server bound to 127.0.0.1 by the process
   * checking it. Both SANs are needed: the two arms below dial the same
   * listener by two names, which is the whole of what this section is about.
   */
  const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDKLowvLSz/FXrr
b04X8k/M8hypYo/wjouMVELDbuwwdAuAUrwC9JgmRrPACdKDMC7RjHtPq9LutwEy
pu1mKEGCRRdQ8kt5oLND2jiW0yPfJm9+vub4DP1S5MvJAa5Q7jPsEt+FPbWg8T4N
9/ln5IFsI77BxrCW3iFms2Xbob4tY2oRCyhmD3PioiFaFk7Q5ieYmprWBWWD9cFF
/XwMVqkv6rFWCN8NSCexW/79SlkpsjYLwWzNbRVJkL6fDm9ZMr0P+iZq+nH4ZHQ4
7R9tn+lU8BcSddZUqPlKZnzM+BYLI7QIG8aLLcl7N3baMcMkz1WtpQVUEzwqW1sb
EzSzQIoxAgMBAAECggEAaMkDIpg5T+MkF81SHhsZvNBmhmtsynI2ZP5us7dTdjFO
nK1EgAugp4XRN2Bf2FoqibRTXJFi+xGh70yQkXefrBJ+6RcKgvkEr8/zsEexub/D
3V63eivRRxsJex4B6DPseRe2/OlkrwsY7Ehu3KeTZCaKgQenEioCCaZEzjXfyMln
SG6R2T5POD9Mx0mes+qmtER7y+scgGMEh+iuxwhZygUVrPifTgLuHzkBV+ybAuwG
ChrCTB+kdx++lVRI49aCuPIAyLrCymMjijswz9Np2wJCDqpwNhIZ+0shCYrkRQiu
OOddAhsKCsbPD07gD1JKY7Wq3txaTLhIZLdqzJ8Q2QKBgQDwl4GNo/TstmgLO0KE
eWiIw0HEIeTuKan5GxMUJwfw3ITDfVaRMKkyr8UsejYz1IzTatzSxEuGuxsjYLK3
9lQDVDkITzBldKbQBcybloXxXHN1/bBoQS2UVEoW0m3WYUy6FEab9sCiHl17cn8p
gtK+CMR5FMJ7sf/JJv3SrTaAwwKBgQDXIU+kraHQEOEBy99luhvoIX3MpXP8zkNd
HvPxRCySSqI2Pvh8c1AawAY20mICskPINeR2h61Jlm6RsZd3tpCX4azBO5ViYcei
zXaQY55ddcPgINd3gi6u0/mqZN8xBvllS/zqtzdxwPdFmRCuW558+nODk2snDhUT
gY2w+vnZ+wKBgBe7ymLvlpy3TcI14VTyKRa8tEMl2NCJuaPCQPqO8yCWkF48ggqm
kzpVzoyZrbklMZM1in0cMhsjYAT4aAjvus/tQgcI0MxhWodQ2yNKEQKDTTyJfxp5
u4ZTXk+sCHvKc2gz0ddW2x/jAPPJkrPEnQd0E/Whz6GmKIZuW0GqJqNDAoGAGIpg
P3TfJJEIWeAb18rnLA/F/fZRyODupkzFnxwbyYRiBLYiOnAdDzAghVhyfcRAHzKm
oS7RAbf7XPtZP/q/e9PulQxq+hIVZ+jwQYBbrGWmtoaIjcV39dGQhXOEUl9tS7Tj
YRMNbBiLHJFdacZhyff3/WZvrsDYfqUkuK+omMkCgYAkCzDu3o4XAP3zxcD8VERh
RnBpggpG1H7/PnuKSzgfGPTyzLUdk6t6o4ElTJ/gyTmti0bpIFB7vWSxlFQnMZpj
g2y/J/v2yi+k175LIfvRFFsnSB5RovaPjWTZ4831AmKXMo/4zGFTbaEBi9utx+vo
+DuUMS4Nd/cdMHLYEIcC3Q==
-----END PRIVATE KEY-----
`;
  const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIICyzCCAbOgAwIBAgIJAJL7X9Yr1ZZ9MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAgFw0yNjA4MTAxODE0MzFaGA8yMTI2MDcxNzE4MTQzMVow
FDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAyi6MLy0s/xV6629OF/JPzPIcqWKP8I6LjFRCw27sMHQLgFK8AvSYJkaz
wAnSgzAu0Yx7T6vS7rcBMqbtZihBgkUXUPJLeaCzQ9o4ltMj3yZvfr7m+Az9UuTL
yQGuUO4z7BLfhT21oPE+Dff5Z+SBbCO+wcawlt4hZrNl26G+LWNqEQsoZg9z4qIh
WhZO0OYnmJqa1gVlg/XBRf18DFapL+qxVgjfDUgnsVv+/UpZKbI2C8FszW0VSZC+
nw5vWTK9D/omavpx+GR0OO0fbZ/pVPAXEnXWVKj5SmZ8zPgWCyO0CBvGiy3Jezd2
2jHDJM9VraUFVBM8KltbGxM0s0CKMQIDAQABox4wHDAaBgNVHREEEzARgglsb2Nh
bGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAF5TLVGaghXztqfXsFjKm5vB
lXWxjmXusBX2iICEQWnwMZRNUW7Lj0KgTK5Ks8SqbsfpcDcX9UL0osRRUQBVP5DW
cDFORlcLepWSc8UY4IqYCCYrUs5URJlPJ36mOkKN62Hos+Z81iwigZ+vmEHTkzBz
InWtw9UHdgOvZ9LCr9Hej/j6zv84fVFLaXFAhbq+vzb9jAGQcxqDNFF2oLuf//Ag
JuhGZsufnd+6wvWOd7OahqlvPEcF56OnRs7DeC3wVJ0qPtGqwKDE839QS8e0hZcs
YpLHmKle/sXYTbf2kos2DWF8HdLcq+3HtNqxK1kM1HvfxNniyhuyj+qsyBTA6Mg=
-----END CERTIFICATE-----
`;

  interface Conversation {
    /** Command lines, in order. The DATA body is not commands and is not here. */
    written: string[];
    ehlos: number;
  }

  /**
   * Enough SMTP to complete one send, answered on whatever stream it is given.
   *
   * `upgrade` is a closure rather than a socket argument so the STARTTLS arm can
   * wrap the *same* socket in a `TLSSocket` without this function knowing what a
   * socket is; `greet` is false on the upgraded stream, because the client sends
   * its second EHLO immediately and a second 220 would be read as its reply.
   */
  const converse = (
    stream: Duplex,
    state: Conversation,
    upgrade: (() => void) | null,
    greet: boolean,
  ): void => {
    let buffer = "";
    let inData = false;
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const at = buffer.indexOf("\r\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            stream.write("250 2.0.0 queued\r\n");
          }
          continue;
        }
        state.written.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          state.ehlos += 1;
          // STARTTLS is offered only before the upgrade, and AUTH only after —
          // the shape of a careful server, and the one that tells a client
          // reusing the first capability list apart from one that does not.
          stream.write(`250-localhost greets you\r\n250 ${upgrade !== null ? "STARTTLS" : "AUTH PLAIN"}\r\n`);
          continue;
        }
        if (upper.startsWith("STARTTLS") && upgrade !== null) {
          stream.write("220 2.0.0 ready to start TLS\r\n");
          stream.removeListener("data", onData);
          upgrade();
          return;
        }
        if (upper.startsWith("AUTH")) {
          stream.write("235 2.7.0 authenticated\r\n");
          continue;
        }
        if (upper.startsWith("DATA")) {
          inData = true;
          stream.write("354 go ahead\r\n");
          continue;
        }
        if (upper.startsWith("QUIT")) {
          stream.write("221 2.0.0 bye\r\n");
          stream.end();
          continue;
        }
        stream.write("250 2.0.0 ok\r\n");
      }
    };
    stream.on("data", onData);
    // `sendMessage` destroys the socket on its way out, so the RST is ordinary
    // and an `error` with no listener is an uncaught exception.
    stream.on("error", () => {
      // Expected: the client hangs up. Nothing here has anything to say about it.
    });
    if (greet) stream.write("220 localhost ESMTP\r\n");
  };

  const envelope = { from: "bot@example.com", to: "ada@example.com", message: "Subject: hi\r\n\r\nbody\r\n" };
  /** A send through the **real** dialer. `null` on success, the error otherwise. */
  const dial = async (over: {
    host: string;
    port: number;
    security: "implicit_tls" | "starttls";
    rejectUnauthorized?: boolean;
  }): Promise<SmtpError | null> => {
    try {
      await sendMessage(
        {
          host: over.host,
          port: over.port,
          security: over.security,
          auth: "plain",
          username: "ada@example.com",
          password: "a mailbox password",
          rejectUnauthorized: over.rejectUnauthorized ?? false,
          ehloName: "[127.0.0.1]",
          dialer: socketDialer(),
          // Short, because a case that hangs on a certificate problem is a case
          // nobody keeps. Every step here is loopback.
          timeouts: { connect: 5_000, greeting: 5_000, ehlo: 5_000, starttls: 5_000, handshake: 5_000, total: 20_000 },
        },
        envelope,
      );
      return null;
    } catch (error) {
      return error instanceof SmtpError ? error : new SmtpError("body", `not an SmtpError: ${String(error)}`);
    }
  };

  /* -- implicit TLS, by IP and by name ------------------------------------ */

  const secureState: Conversation = { written: [], ehlos: 0 };
  const secureServer = tlsCreateServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (socket) => {
    converse(socket, secureState, null, true);
  });
  await new Promise<void>((resolve) => secureServer.listen(0, "127.0.0.1", () => resolve()));
  const securePort = (secureServer.address() as AddressInfo).port;

  for (const host of ["127.0.0.1", "localhost"]) {
    secureState.written.length = 0;
    secureState.ehlos = 0;
    const failure = await dial({ host, port: securePort, security: "implicit_tls" });
    report(
      `an implicit-TLS send to ${host} completes`,
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    /*
     * The transcript as well as the outcome, because `tls.connect` throwing
     * synchronously produces a rejection at *some* step for *some* reason, and
     * this is what says the whole conversation happened over the encrypted
     * socket rather than that one error was swapped for another.
     */
    check(`and ${host} spoke the whole conversation`, secureState.written, [
      "EHLO [127.0.0.1]",
      `AUTH PLAIN ${Buffer.from("\0ada@example.com\0a mailbox password", "utf8").toString("base64")}`,
      "MAIL FROM:<bot@example.com>",
      "RCPT TO:<ada@example.com>",
      "DATA",
      "QUIT",
    ]);
  }

  /*
   * **And the certificate really is checked**, which is the half that says
   * `rejectUnauthorized: false` above is doing something rather than describing
   * a TLS layer that trusts everything. A self-signed certificate against the
   * default `true` fails in `tls.connect`'s own verification, before the
   * greeting, and reaches the caller as a `connect` refusal rather than as an
   * unhandled `error` event on a socket nobody is listening to.
   */
  {
    const refused = await dial({ host: "127.0.0.1", port: securePort, security: "implicit_tls", rejectUnauthorized: true });
    check("an untrusted certificate is refused at connect, and not permanently", [refused?.step, refused?.permanent], [
      "connect",
      false,
    ]);
    report(
      "and the refusal carries the reason a certificate was rejected",
      /self.signed|certificate/i.test(refused?.message ?? ""),
      refused?.message ?? "(delivered)",
    );
  }
  secureServer.close();

  /* -- STARTTLS, upgrading the socket it is already on --------------------- */

  {
    /*
     * The other real-socket path, and the one whose *ordering* the fake already
     * asserts: what is added here is that the upgrade is a real handshake on a
     * socket that has already carried cleartext. `ReplyReader.release` is what
     * makes that work — left attached, the raw socket's `data` handler competes
     * with the TLS layer for the handshake bytes and its `close` marks a reader
     * that is by then reading the encrypted stream, which is a failure no fake
     * can produce because a `PassThrough` has no handle to take over.
     */
    const state: Conversation = { written: [], ehlos: 0 };
    const plainServer = netCreateServer((socket: Socket) => {
      converse(socket, state, () => {
        const secure = new TLSSocket(socket, { isServer: true, key: TEST_TLS_KEY, cert: TEST_TLS_CERT });
        secure.on("secure", () => converse(secure, state, null, false));
      }, true);
    });
    await new Promise<void>((resolve) => plainServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (plainServer.address() as AddressInfo).port;

    const failure = await dial({ host: "127.0.0.1", port, security: "starttls" });
    report(
      "a STARTTLS send over a real socket completes",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    check("and the second EHLO happened on the encrypted stream", state.written.slice(0, 4), [
      "EHLO [127.0.0.1]",
      "STARTTLS",
      "EHLO [127.0.0.1]",
      `AUTH PLAIN ${Buffer.from("\0ada@example.com\0a mailbox password", "utf8").toString("base64")}`,
    ]);
    plainServer.close();
  }
}

/* ------------------------------------------------------------------ *
 * The outbox
 *
 * The queue is where the only plaintext credential in this database sits:
 * `mail_outbox.body` holds the rendered message including its one-time link,
 * beside the key that mints every token in the fleet. Every case below that
 * asserts a state transition asserts **`body IS NULL` with it**, because each
 * of the three terminal paths reaches that state by its own statement and two
 * of them have been written without it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe outbox\n");
{
  const fresh = (): DatabaseSync => {
    const made = new DatabaseSync(":memory:");
    applyControlPlaneSchema(made);
    return made;
  };
  const queued: EnqueueArgs = {
    to: "Ada@Example.com",
    kind: "reset",
    subject: "Reset your password",
    text: "https://cp.example/reset#t=ut_livetoken",
    html: "<a href='https://cp.example/reset#t=ut_livetoken'>reset</a>",
    notAfter: Date.now() + 60 * 60 * 1000,
  };
  const rowOf = (db: DatabaseSync, id: string): Record<string, unknown> =>
    (db.prepare("SELECT sent_at, failed_at, last_error, body FROM mail_outbox WHERE id = ?").get(id) ??
      {}) as Record<string, unknown>;

  /* -- delivered --------------------------------------------------------- */

  {
    const odb = fresh();
    const id = enqueueMail(odb, queued);
    check("a queued message has an id", typeof id, "string");
    const claimed = claimNextMail(odb, Date.now());
    check("and is claimable exactly once", [claimed?.id === id, claimed?.attempts], [true, 1]);
    // The lease, as one conditional UPDATE: the second pump is two containers
    // started against one volume by accident, and that is precisely the moment a
    // duplicate reset link goes out.
    check("a second claim at the same instant gets nothing", claimNextMail(odb, Date.now()), null);

    recordMailSent(odb, String(id));
    const row = rowOf(odb, String(id));
    check("recording a send marks it sent", row["sent_at"] !== null, true);
    /*
     * **The half that matters, and it is one statement rather than two** — so
     * there is no window in which a row is both "sent" and still carrying a
     * working link, and no path on which a later early return skips the second
     * write.
     */
    check("and drops the live link in the same statement", row["body"], null);
    odb.close();
  }

  /* -- given up on ------------------------------------------------------- */

  {
    const odb = fresh();
    const id = String(enqueueMail(odb, queued));
    const claimed = claimNextMail(odb, Date.now());
    if (claimed === null) throw new Error("the row this case is about was not claimable");
    recordMailFailure(odb, claimed, new SmtpError("mail_from", "refused", 550, "550 5.1.8 no"));
    const row = rowOf(odb, id);
    /*
     * A 5xx gives up on the **first** attempt rather than after eight, and that
     * is what makes forgetting `body = NULL` here a week-long leak rather than a
     * momentary one: `claimNextMail` filters on `failed_at IS NULL`, so nothing
     * ever looks at the row again and `pruneMailOutbox` only removes it once the
     * seven-day retention has passed.
     */
    check("a permanent refusal is terminal at once", [row["failed_at"] !== null, row["last_error"]], [
      true,
      "mail_from: refused",
    ]);
    check("and the body goes with it", row["body"], null);

    /*
     * **And an admin can now find out**, which is the half that was missing.
     *
     * The row above is the state a first user's invitation ends in when a
     * provider rejects the sender: terminal, explained, and reported nowhere a
     * person looks. `mailHealth` is what the Server settings screen reads, and
     * `last_error` is the field that names the fix — a count says something is
     * wrong, "550 5.1.8 no" says what.
     */
    const health = mailHealth(odb);
    check(
      "a failure is counted and its own words are kept",
      [health.failed, health.pending, health.lastError],
      [1, 0, "mail_from: refused"],
    );
    report("and it is stamped", health.lastFailedAt !== null, `lastFailedAt: ${String(health.lastFailedAt)}`);
    odb.close();
  }

  /* -- a queue nothing is draining --------------------------------------- */

  {
    /*
     * The third state, and the one with no error to report: messages queued,
     * nothing failed, nothing going out. That is what an admin sees while SMTP
     * is misconfigured in a way the settings check does not catch, and the age of
     * the oldest is the only thing that distinguishes it from a healthy queue
     * with something in flight.
     */
    const odb = fresh();
    const now = Date.now();
    enqueueMail(odb, queued, now - 3 * 60 * 60 * 1000);
    enqueueMail(odb, queued, now - 60_000);
    const health = mailHealth(odb, now);
    check("two waiting, none failed", [health.pending, health.failed, health.lastError], [2, 0, null]);
    report(
      "and the age reported is the oldest one's",
      health.oldestPendingMs !== null && health.oldestPendingMs >= 3 * 60 * 60 * 1000,
      `oldestPendingMs: ${String(health.oldestPendingMs)}`,
    );
    odb.close();
  }

  /* -- expired before anybody could send it ------------------------------ */

  {
    /*
     * **No dialer and no configuration**, which is the state this exists for:
     * `drain` returns before claiming anything while `mailConfig` is null, so a
     * message queued when SMTP worked and orphaned when an admin cleared a
     * setting was never claimed, never expired and never failed — and kept its
     * one-time link for the life of the volume.
     */
    const odb = fresh();
    const id = String(enqueueMail(odb, { ...queued, notAfter: Date.now() - 1 }));
    check("one row was past its deadline", expireStaleMail(odb), 1);
    const row = rowOf(odb, id);
    check(
      "an expired row is failed, explained, and emptied",
      [row["failed_at"] !== null, row["last_error"], row["body"]],
      [true, "expired before delivery", null],
    );
    check("and running it again finds nothing left to do", expireStaleMail(odb), 0);
    odb.close();
  }

  /* -- the backoff curve -------------------------------------------------- */

  /*
   * Full jitter from an injected source, so the curve is walkable. At 0.5 the
   * multiplier is exactly 1.0, which is what makes these numbers the *flat*
   * curve rather than a sample of it: doubling from a minute, and then an hour
   * for ever. A ceiling reached by `Math.min` on the product is the only thing
   * standing between eight attempts and an exponent nobody bounded.
   */
  {
    const walked = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((attempts) => backoffMs(attempts, () => 0.5));
    check("the backoff doubles from a minute and stops at an hour", walked, [
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    report(
      "and never goes backwards",
      walked.every((value, index) => index === 0 || value >= (walked[index - 1] ?? 0)),
      walked.join(" → "),
    );
  }

  /* -- the breaker -------------------------------------------------------- */

  {
    /*
     * A mail server that is down does not become up because we asked eight more
     * times, and every attempt costs a libuv threadpool slot — the same pool
     * `scrypt` runs on and `serveStatic` draws from. The breaker is what keeps a
     * mail outage from becoming a sign-in outage, and the only way to see it is
     * to run the pump against a dialer that always refuses.
     */
    const odb = fresh();
    for (const [key, value] of [
      ["smtp.host", "fake.example"],
      ["smtp.auth", "none"],
      ["mail.from", "bot@example.com"],
      ["mail.public_url", "https://cp.example"],
    ] as const) {
      writeSetting(odb, key, value, null);
    }

    const events: MailEvent[] = [];
    const pump = startMailPump({
      db: odb,
      dialer: { connect: () => Promise.reject(new Error("ECONNREFUSED")) },
      onEvent: (event) => events.push(event),
      tickMs: 5,
      random: () => 0.5,
    });
    // Six rather than five, so the breaker opens with a claimable row still
    // waiting: opening because the queue merely ran out would prove nothing.
    for (let index = 0; index < 6; index += 1) {
      pump.enqueue({ ...queued, to: `ada+${index}@example.com` });
    }
    for (let waited = 0; waited < 200 && !events.includes("breaker_open"); waited += 1) await sleep(5);
    pump.stop();

    check("the breaker opened", events.includes("breaker_open"), true);
    // Five consecutive failures, and the count is the assertion: a breaker that
    // opens on the first failure is a mail feature nobody can use, and one that
    // opens on the fortieth is not a breaker.
    check("after exactly five failures in a row", events.slice(0, events.indexOf("breaker_open")), [
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    check("and it says so to whoever is listening", pump.paused(), true);
    odb.close();
  }

  /* -- a transport that stalls, and the flag that must not stay set -------- */

  {
    /*
     * **`drain` clears `running` in a `finally`, and that is the only thing
     * standing between one wedged socket and a fleet that never sends mail
     * again.** An await inside `deliver` that never settles leaves the flag set,
     * and every later `wake()`, `enqueue()` and tick then returns at the first
     * line for the life of the process — silently, with the queue filling up and
     * every route still answering 200. No case here had ever driven a transport
     * that neither answers nor fails.
     *
     * What is driven is the ceiling that actually fires: the dialer below
     * **connects and then says nothing at all**, which is the shape of a
     * black-holed MX and of a host that accepted the SYN, and `ReplyReader`
     * bounds it at `SMTP_TIMEOUTS.greeting`. That is ten seconds of wall clock
     * and is the reason this is one case rather than several.
     *
     * **The pump's own watchdog is deliberately not what this drives.**
     * `DELIVER_WATCHDOG_MS` is computed at module load from
     * `SMTP_TIMEOUTS.total` and `PumpOptions` carries no override, so a dialer
     * whose `connect` never *resolves* — the only shape that gets past
     * `smtp.ts` — costs 105 seconds here. Said out loud so the gap is a known
     * one rather than a thing this case implies it covers.
     *
     * Two phases, and the second is the assertion. A stalled message that is
     * merely given up on proves the client; a *second* message going out
     * afterwards is the only thing that proves the pump was released, because
     * under the regression the first `failed` event never arrives either and the
     * wait below is what reddens instead of hanging.
     */
    const odb = fresh();
    for (const [key, value] of [
      ["smtp.host", "silent.example"],
      ["smtp.auth", "none"],
      ["mail.from", "bot@example.com"],
      ["mail.public_url", "https://cp.example"],
    ] as const) {
      writeSetting(odb, key, value, null);
    }

    let silent = true;
    const stalling: SmtpDialer = {
      connect: () =>
        silent
          ? // Connected, and then nothing: no greeting, no close, no error. The
            // `PassThrough` is never written to and never ended.
            Promise.resolve({
              stream: new PassThrough(),
              startTls: () => Promise.resolve(null),
              close(): void {
                // Nothing to tear down; the point of this dialer is that it does
                // nothing at all.
              },
            })
          : Promise.reject(new Error("ECONNREFUSED")),
    };

    const events: [MailEvent, string][] = [];
    const pump = startMailPump({
      db: odb,
      dialer: stalling,
      onEvent: (event, detail) => events.push([event, detail]),
      tickMs: 5,
      random: () => 0.5,
    });
    const until = async (want: () => boolean, budgetMs: number): Promise<boolean> => {
      const stop = Date.now() + budgetMs;
      while (Date.now() < stop) {
        if (want()) return true;
        await sleep(20);
      }
      return want();
    };

    pump.enqueue({ ...queued, to: "silent@example.com" });
    await sleep(200);
    check("a transport that says nothing has not answered either way yet", events.length, 0);

    const gaveUp = await until(() => events.length > 0, 14_000);
    report("a stalled read is given up on rather than held", gaveUp, events.map(([event]) => event).join(" · "));
    check("and it is reported as a failure, not a send", events[0]?.[0], "failed");
    const stalled = (odb
      .prepare("SELECT failed_at, last_error FROM mail_outbox WHERE to_address = 'silent@example.com'")
      .get() ?? {}) as Record<string, unknown>;
    /*
     * The **step** is on the row rather than in the event: `onEvent` carries
     * `describe(error)`, which is the message alone, and `recordMailFailure`
     * writes `${step}: ${message}`. That column is the whole of what an operator
     * has on the delivery screen, and it is what tells "the host accepted the
     * connection and then said nothing" apart from "the host refused it".
     */
    report(
      "and the row records which read timed out",
      String(stalled["last_error"] ?? "").startsWith("greeting:"),
      String(stalled["last_error"] ?? "(nothing)"),
    );
    check(
      "the row is left retryable rather than terminal, because a stall says nothing about the message",
      stalled["failed_at"],
      null,
    );

    silent = false;
    pump.enqueue({ ...queued, to: "after@example.com" });
    const recovered = await until(() => events.length > 1, 3_000);
    report(
      "and the next message is picked up, so `running` was released",
      recovered,
      events.map(([event, detail]) => `${event}: ${detail}`).join(" · "),
    );
    pump.stop();
    odb.close();
  }
}

/* ------------------------------------------------------------------ *
 * A message as bytes, and an address as a string
 *
 * `message.ts` is pure — the date, the boundary and the message id are all
 * parameters — so this is the one subsystem here whose output can be asserted
 * byte for byte with nothing running.
 * ------------------------------------------------------------------ */

process.stdout.write("\na message as bytes, and an address as a string\n");
{
  /* -- RFC 2047, chunked by code point ----------------------------------- */

  {
    /*
     * **The bug everybody ships, and it is invisible in every single-word
     * test.** An encoded-word holds 45 bytes of input; slicing the UTF-8 *bytes*
     * at 45 splits a multi-byte character across two words, and each word is
     * decoded independently by the receiver — so the result is two invalid
     * sequences and a subject full of replacement characters. Fifteen four-byte
     * emoji is 60 bytes, which is the smallest subject that needs two words and
     * therefore the smallest one that can show it.
     */
    const subject = "🙂".repeat(15);
    const encoded = encodeWord(subject);
    const words = [...encoded.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)].map((match) => match[1] ?? "");
    report("a long emoji subject needs more than one encoded-word", words.length >= 2, `${words.length} words`);
    // Decoded **independently and concatenated**, which is what a receiver does
    // and the only arrangement byte-chunking fails.
    check(
      "and every word decodes on its own back into the whole subject",
      words.map((word) => Buffer.from(word, "base64").toString("utf8")).join(""),
      subject,
    );
    const longest = Math.max(...encoded.split("\r\n ").map((word) => word.length));
    report("no word is longer than RFC 2047 allows", longest <= 75, `${longest} characters`);
  }

  /* -- a header value that would end the header --------------------------- */

  {
    /*
     * **Throws rather than strips**, and the difference is the point: every value
     * reaching here came from the settings screen or a template, so stripping
     * silently changes what an admin configured and makes the defence invisible.
     */
    let threw = false;
    try {
      headerSafe("Subject", "a\r\nBcc: x@y");
    } catch {
      threw = true;
    }
    check("a header value carrying a CRLF is refused rather than cleaned up", threw, true);
  }

  /* -- the bytes ---------------------------------------------------------- */

  {
    const built = buildMessage({
      from: { address: "bot@example.com", name: null },
      to: "ada@example.com",
      replyTo: null,
      subject: "hello",
      // Every line of this would begin with a dot if it survived as text.
      text: ".\n.hidden\n.",
      html: "<p>.</p>",
      date: new Date(0),
      boundary: "reemoat-fixed",
      messageId: "abcdef",
    });
    // CRLF is produced here and nowhere else, so one bare LF anywhere is a
    // message some receiver will read as ending early.
    check("every line ends CRLF, with no bare LF anywhere", /[^\r]\n/.test(built), false);
    /*
     * The reason both parts are base64 rather than quoted-printable, stated as a
     * consequence: the alphabet excludes `.`, so no body line can begin with one
     * and SMTP's transparency rule can never fire on a message this builds.
     */
    check(
      "and no line begins with a dot, because both parts are base64",
      built.split("\r\n").some((line) => line.startsWith(".")),
      false,
    );
    // Kept anyway: the rule belongs to the format rather than to today's encoding
    // choice, and its absence would be a silently truncated message.
    check("dot-stuffing still doubles a leading dot on every line", dotStuff(".a\r\n.b\r\nc"), "..a\r\n..b\r\nc");
    // RFC 5322's date with a numeric zone, not `toUTCString()`'s trailing `GMT`
    // — which is RFC 7231's and merely tolerated here.
    check("the date is the one this document is supposed to carry", /^Date: Thu, 01 Jan 1970 00:00:00 \+0000$/m.test(built), true);
  }

  /* -- what may be used as an address ------------------------------------- */

  /*
   * Structural rather than canonical: the whole security content is "no control
   * characters", because `MAIL FROM:<…>` and `To:` are line-oriented and a CR
   * inside an address is a `Bcc:` somebody else wrote. Everything else refused
   * here is refused because handling it means implementing the quoting rules
   * that make it safe.
   */
  {
    const refusals: [string, string][] = [
      ["a header injected through the address", "a@b\r\nBcc: c@d"],
      ["a NUL, which truncates in whichever layer expects it least", "a\x00@b"],
      ["a comma, which separates two addresses", "a,b@c"],
      ["angle brackets, which delimit one", "<a@b>"],
      ["a quote, which opens a quoted string", 'a"@b'],
      ["two @s, which `lastIndexOf` would have admitted", "a@b@c"],
      ["nothing before the @", "@b"],
      ["no domain after it", "a@"],
      ["and one longer than a forward-path may be", `${"a".repeat(255)}@b`],
    ];
    for (const [what, value] of refusals) {
      check(`an address is refused for ${what}`, checkEmailAddress(value).ok, false);
    }
    /*
     * **A trailing newline is trimmed rather than refused**, and that is asserted
     * here because it is the one entry somebody would expect on the list above.
     * `checkEmailAddress` trims *before* it looks for control characters, so what
     * is stored can never carry one — the refusal would be about tidiness, and
     * refusing an address is refusing a person who cannot then sign up.
     */
    check("but a trailing newline is trimmed off and accepted", checkEmailAddress("a@b\n"), {
      ok: true,
      address: "a@b",
      folded: "a@b",
    });
    check("an ordinary address is accepted", checkEmailAddress("Ada@example.com").ok, true);
    // Self-hosted intranet domains have no dot, and this is a self-hosted
    // product. A stricter check here is somebody who cannot recover an account.
    check("and so is an intranet domain with no dot at all", checkEmailAddress("ada@intranet").ok, true);
  }

  {
    /*
     * The property the partial unique index on verified rows rests on: two
     * spellings of one address must fold to one string, or `Ada@x` and `ada@x`
     * are two accounts receiving the same mail — which is a reset flow pointing
     * at an address the other account also controls.
     */
    check("folding lowercases the whole address, local part included", foldEmail("Ada@EXAMPLE.COM"), "ada@example.com");
    const upper = checkEmailAddress("Ada@X");
    const lower = checkEmailAddress("ada@x");
    check(
      "so two spellings of one address compare equal",
      [upper.ok && lower.ok && upper.folded === lower.folded, upper.ok ? upper.folded : null],
      [true, "ada@x"],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Settings, and where each value came from
 *
 * One rule: **a row in `instance_settings` wins, the environment is the
 * fallback, and absence of both is `unset`**. Four cells, and the third — that
 * clearing an override hands the environment back rather than leaving a hole —
 * is the one an implementation writing `""` on clear gets wrong.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsettings, and where each value came from\n");
{
  const sdb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(sdb);

  /* -- provenance --------------------------------------------------------- */

  {
    const key = "smtp.host" as const;
    const variable = envNameFor(key);
    const held = process.env[variable];
    process.env[variable] = "env.example";

    check("with no row the environment answers, and says so", readSetting(sdb, key), {
      value: "env.example",
      source: "environment",
    });
    writeSetting(sdb, key, "db.example", "u_admin");
    check("a row beats it", readSetting(sdb, key), { value: "db.example", source: "database" });
    clearSetting(sdb, key);
    // The reason clearing is its own verb rather than writing `""`: an empty
    // string in the database is a *value* — "this server wants no username" — so
    // a clear that wrote one would shadow the environment for ever.
    check("and clearing the override hands the environment back", readSetting(sdb, key), {
      value: "env.example",
      source: "environment",
    });
    delete process.env[variable];
    check("with neither, it is unset rather than empty", readSetting(sdb, key), { value: null, source: "unset" });

    if (held === undefined) delete process.env[variable];
    else process.env[variable] = held;
  }

  /* -- what a write may say ----------------------------------------------- */

  {
    /*
     * **`mail.from` is the entry with a story.** The comment it replaced said the
     * two addresses were "checked where they are used" — they were not:
     * `checkEmailAddress` had a call site for every address arriving in a request
     * *body* and none for one arriving as a setting. So a display name typed into
     * the From field went straight into `MAIL FROM:<…>`, `mailConfigured`
     * reported `configured: true` on the strength of the field being non-empty,
     * and every message on the instance died.
     */
    check(
      "a port outside the range, a security nobody offers, and a From that is not an address",
      [
        checkSettingValue("smtp.port", "70000"),
        checkSettingValue("smtp.security", "tls"),
        checkSettingValue("mail.from", "reemoat <bot@example.com>"),
        checkSettingValue("mail.from", "bot@example.com"),
      ].map((message) => message === null),
      [false, false, false, true],
    );
    // Empty is allowed through deliberately: `mail.reply_to` is optional, and an
    // empty `mail.from` is caught by `mailConfigured` as *missing*, which is a
    // better sentence than "malformed".
    check("an empty optional address is not malformed", checkSettingValue("mail.reply_to", ""), null);
  }

  /* -- the environment name of every key ---------------------------------- */

  /*
   * A loop rather than a transcribed list, because a second hand-maintained one
   * is exactly the coupling `.dockerignore` and the Dockerfile earned their
   * warning for. What is pinned by name is the handful the deploy scripts and
   * `.env.example` write, which is where a drift would show.
   */
  {
    const names = SETTING_KEYS.map(envNameFor);
    check("every key gets its own environment name", new Set(names).size, SETTING_KEYS.length);
    report(
      "each is REEMOAT_CP_, upper case, with no dot left in it",
      names.every((name) => name.startsWith("REEMOAT_CP_") && name === name.toUpperCase() && !name.includes(".")),
      names.join(" "),
    );
    check(
      "and the two the env file writes are spelled the way it writes them",
      [envNameFor("smtp.host"), envNameFor("mail.public_url")],
      ["REEMOAT_CP_SMTP_HOST", "REEMOAT_CP_MAIL_PUBLIC_URL"],
    );
  }

  sdb.close();
}

/* ------------------------------------------------------------------ *
 * The three startup sweeps
 *
 * `pruneRegistrations`, `pruneEmailTokens` and `pruneMailOutbox` are reachable
 * from **no route at all** — `main.ts` calls them once, at boot, beside
 * `pruneSessions` — so route coverage cannot stand in for them and nothing in
 * this file had ever executed one. Each is driven directly against a seeded
 * database, and each is driven with a row it must *keep* beside the row it must
 * remove, because a sweep that deletes everything passes every one-row case.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe three startup sweeps\n");
{
  const sweepDb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(sweepDb);
  const at = Date.now();
  const HOUR = 60 * 60 * 1000;

  /* -- expired sign-ups, and the name one was holding --------------------- */

  {
    /*
     * **`pruneRegistrations`' docblock says "this is what releases a held
     * name", and the release is not actually this function's doing** — worth
     * writing down rather than paraphrasing, because the two constants make the
     * sentence *nearly* true. `nameTaken` filters `expires_at > now`, so the
     * name comes back the instant the row lapses, with nothing swept; the sweep
     * only reclaims the row a **further** `REGISTRATION_TTL_MS` later
     * (`expires_at < now - TTL`). Both halves are asserted in that order, so
     * whichever one somebody changes has a case pointing at it.
     */
    const seed = (name: string, ttlMs: number): void => {
      mintRegistration(sweepDb, { name, email: `${name}@example.com`, passwordHash: "not a real hash" }, ttlMs, at);
    };
    seed("live", REGISTRATION_TTL_MS);
    seed("lapsed", -HOUR);
    seed("ancient", -(REGISTRATION_TTL_MS + HOUR));

    check("a live sign-up holds its login name", nameTaken(sweepDb, "live", at), true);
    check("and one that has lapsed does not, before anything is swept", nameTaken(sweepDb, "lapsed", at), false);
    check("the sweep takes only what lapsed more than a whole TTL ago", pruneRegistrations(sweepDb, at), 1);
    check(
      "so the row that is still worth reading survives it",
      sweepDb
        .prepare("SELECT name FROM pending_registrations ORDER BY name")
        .all()
        .map((row) => String(row["name"])),
      ["lapsed", "live"],
    );
    check("and running it again finds nothing left to do", pruneRegistrations(sweepDb, at), 0);
  }

  /* -- expired links ------------------------------------------------------ */

  {
    /*
     * The same shape one table over, and the same grace: a token is unusable the
     * moment it expires — `readEmailToken` filters `expires_at > now` — and the
     * row is kept a further `VERIFY_TTL_MS` so "why did my link not work" stays
     * answerable for a day. Asserted as the pair, because a sweep keyed on
     * `expires_at < now` would delete the row somebody is asking about.
     */
    const live = mintEmailToken(sweepDb, "u_live", "verify", "live@example.com", VERIFY_TTL_MS, at);
    const lapsed = mintEmailToken(sweepDb, "u_lapsed", "verify", "lapsed@example.com", -HOUR, at);
    mintEmailToken(sweepDb, "u_ancient", "reset", "ancient@example.com", -(VERIFY_TTL_MS + HOUR), at);

    check("a live link reads back", readEmailToken(sweepDb, live.token, at)?.userId, "u_live");
    check("an expired one is already unusable while its row is still there", readEmailToken(sweepDb, lapsed.token, at), null);
    check("the sweep takes only the one nobody could still be asking about", pruneEmailTokens(sweepDb, at), 1);
    check(
      "and leaves the other two",
      sweepDb
        .prepare("SELECT user_id FROM user_email_tokens ORDER BY user_id")
        .all()
        .map((row) => String(row["user_id"])),
      ["u_lapsed", "u_live"],
    );
  }

  {
    /*
     * ⭐ **The table that had no sweeper at all**, and `throttle.ts` had already
     * said so in a comment — *"against a table nothing prunes (`DELETE FROM
     * enrollment_codes` exists nowhere)"* — for a release before anything acted
     * on it. Minting burns the previous code per machine, so the *live* set is
     * bounded; what grew without limit was the dead set, one row per code ever
     * minted, in the same file as the signing key.
     *
     * Both halves of "dead" are asserted, because they expire differently and a
     * sweep keyed on either alone gets one of them wrong: a **used** code is dead
     * from `used_at`, an unredeemed one at `expires_at`. Keyed on `created_at` —
     * the tempting third option — it would delete a live code out from under a
     * machine still holding it, which is the arm the live row here exists to pin.
     */
    const codes = new DatabaseSync(":memory:");
    applyControlPlaneSchema(codes);
    const DAY = 24 * HOUR;
    const row = (id: string, expiresAt: number, usedAt: number | null): void => {
      codes
        .prepare(
          "INSERT INTO enrollment_codes (id, code_hash, machine_id, created_by, created_at, expires_at, used_at) " +
            "VALUES (?, ?, 'm_1', 'u_1', ?, ?, ?)",
        )
        .run(id, `hash_${id}`, at - 30 * DAY, expiresAt, usedAt);
    };
    row("ec_live", at + HOUR, null);
    row("ec_just_expired", at - HOUR, null);
    row("ec_just_used", at - HOUR, at - HOUR);
    row("ec_old_expired", at - 8 * DAY, null);
    row("ec_old_used", at + 30 * DAY, at - 8 * DAY);

    check("the sweep takes only what nothing can ask about any more", pruneEnrollmentCodes(codes, at), 2);
    check(
      "so a live code, and both records still inside the window, survive",
      codes
        .prepare("SELECT id FROM enrollment_codes ORDER BY id")
        .all()
        .map((r) => String(r["id"])),
      ["ec_just_expired", "ec_just_used", "ec_live"],
    );
    /*
     * The one a `created_at` key would have taken: minted a month ago and still
     * redeemable, because minting is what sets the expiry and not the age.
     *
     * ⚠ **On its own database, and that is what makes it an assertion.** This read
     * `pruneEnrollmentCodes(codes, at)` a second time against the rows above — where
     * the first call had already taken everything it could, so a deterministic
     * `DELETE … WHERE …` had to answer 0 whatever the predicate was. It could not
     * fail, including for an implementation keyed on `created_at`, which is the one
     * thing it names.
     */
    const aged = new DatabaseSync(":memory:");
    applyControlPlaneSchema(aged);
    aged
      .prepare(
        "INSERT INTO enrollment_codes (id, code_hash, machine_id, created_by, created_at, expires_at, used_at) " +
          "VALUES ('ec_aged', 'hash_aged', 'm_1', 'u_1', ?, ?, NULL)",
      )
      .run(at - 30 * DAY, at + HOUR);
    check("and age alone never retires a code", pruneEnrollmentCodes(aged, at), 0);
    check(
      "so the month-old code a machine is still holding is still there",
      aged.prepare("SELECT id FROM enrollment_codes").all().map((r) => String(r["id"])),
      ["ec_aged"],
    );
    aged.close();
    codes.close();
  }

  /* -- the outbox, on both of its arms ------------------------------------ */

  {
    /*
     * **Two `DELETE`s, and the second one is the one that was missing.** Arm one
     * removes rows that reached a terminal state long ago. Arm two removes rows
     * that reached **no** state at all — a message queued while SMTP worked and
     * orphaned when an admin cleared a setting is never claimed (`drain` returns
     * before claiming while `mailConfig` is null), never expired and never
     * failed, so arm one cannot see it by construction. It kept its `body`, i.e.
     * its one-time link, for the life of the volume.
     *
     * `RETENTION_MS` is private to `outbox.ts`, so the fixtures sit far either
     * side of it rather than on it: what this pins is the two arms and what each
     * spares, not the number of days.
     */
    const LONG_AGO = 30 * 24 * HOUR;
    const insert = sweepDb.prepare(
      "INSERT INTO mail_outbox (id,to_address,to_folded,kind,subject,body,created_at,not_after,next_at,attempts,sent_at,failed_at) " +
        "VALUES (?,?,?,'reset','Reset your password','{\"text\":\"https://cp.example/reset#t=ut_livetoken\"}',?,?,?,0,?,?)",
    );
    //          id                 created_at      not_after      sent_at        failed_at
    insert.run("mo_sent_old", "a@e", "a@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null);
    insert.run("mo_failed_old", "b@e", "b@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null, at - LONG_AGO);
    insert.run("mo_sent_now", "c@e", "c@e", at, at + HOUR, at, at, null);
    insert.run("mo_stalled_old", "d@e", "d@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null, null);
    // Old, and still live: `not_after` is in the future, so arm two must not
    // reach it however old the row is.
    insert.run("mo_live_old", "e@e", "e@e", at - LONG_AGO, at + HOUR, at - LONG_AGO, null, null);

    check("the sweep takes three of the five", pruneMailOutbox(sweepDb, at), 3);
    check(
      "and what is left is the recent delivery and the row that can still be sent",
      sweepDb
        .prepare("SELECT id FROM mail_outbox ORDER BY id")
        .all()
        .map((row) => String(row["id"])),
      ["mo_live_old", "mo_sent_now"],
    );
    /*
     * Named on its own, because it is the arm with no other reader: the stalled
     * row is neither sent nor failed, so *nothing else in this service* would
     * ever have removed it, and what went with it was a rendered password-reset
     * link.
     */
    check(
      "the row that never reached any state at all went with them",
      sweepDb.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE id = 'mo_stalled_old'").get()?.["n"],
      0,
    );
    check("and a second pass finds nothing", pruneMailOutbox(sweepDb, at), 0);
  }

  sweepDb.close();
}

/* ------------------------------------------------------------------ *
 * Registration, recovery, and the mail that carries them
 *
 * A recording mail sink rather than a socket. The one property about mail an
 * offline driver *can* reach is that **a mailer which never resolves cannot
 * fail a request or delay it**, because no route awaits a send — and that is
 * the whole reason `mail` is an injected interface rather than the pump.
 * ------------------------------------------------------------------ */

process.stdout.write("\nregistration, recovery, and the mail that carries them\n");
{
  const gdb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(gdb);
  ensureSigningKey(gdb);

  const mailed: EnqueueArgs[] = [];
  /*
   * Recording **and** writing the row, which the array alone cannot stand in
   * for: two rules read `mail_outbox` rather than the sender. `sentRecently` is
   * what bounds the notice to a real owner at one a day, and `enqueueMail` is
   * what refuses past `MAX_OUTBOX_PENDING` — the refusal both register arms have
   * to survive identically. Nothing is pushed for a message that was not
   * accepted, so `mailed` stays "what went out" rather than "what was offered".
   */
  const sink = {
    enqueue(args: EnqueueArgs): string | null {
      const id = enqueueMail(gdb, args);
      if (id !== null) mailed.push(args);
      return id;
    },
    wake(): void {},
  };
  const opKey = newApiKey();
  gdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_op','op',1,0)").run();
  gdb
    .prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?,?,?,?,0)")
    .run(newId("ak"), "u_op", opKey.prefix, opKey.hash);

  const gapp = createControlPlaneApp({
    db: gdb,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl: "ws://relay.invalid",
    mail: sink,
  });
  const op = { authorization: `Bearer ${opKey.key}`, "content-type": "application/json" };
  const gpost = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
  ): Promise<Response> =>
    Promise.resolve(gapp.request(path, { method: "POST", headers, body: JSON.stringify(body) }));
  const gget = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(gapp.request(path, { headers }));
  const codeOf = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? "(none)",
  ];
  const tokenOf = (kind: string): string =>
    /#t=([A-Za-z0-9_-]+)/.exec([...mailed].reverse().find((m) => m.kind === kind)?.text ?? "")?.[1] ?? "";

  /**
   * Let `POST /v1/forgot`'s deferred half run before reading what it queued.
   *
   * That route answers `{sent: true}` and *then* looks the owner up, mints the
   * token and queues the mail, because doing any of it first made the response
   * time say whether the address owned an account — identical bodies, one branch
   * paying three fsync'd transactions. So there is deliberately nothing in the
   * outbox when the response resolves, and every assertion about what it mailed
   * has to yield one macrotask first.
   *
   * Named rather than inlined: an assertion that reads `mailed` without this
   * fails in a way that looks like "the mail was not sent" and is really "the
   * driver did not wait", and the next person to hit it should find the answer
   * attached to the thing they call.
   */
  const settled = (): Promise<void> => new Promise((resolve) => setImmediate(() => resolve()));

  /* -- closed by default ------------------------------------------------- */

  check(
    "registration is closed unless somebody opened it",
    ((await (await gget("/v1/instance")).json()) as { registration: { enabled: boolean } }).registration.enabled,
    false,
  );

  /*
   * ⭐ **The AGPL §13 source offer, and the two ways it silently stops being one.**
   *
   * `GET /v1/instance` is above THE LINE, which is the whole point: the users the
   * clause is owed to are the ones who cannot sign in. So the offer is asserted
   * on the *unauthenticated* response rather than on the constant.
   *
   * The version is a literal in `app.ts` rather than a read of `package.json` —
   * a runtime file read is a new failure path on a service whose design goal is
   * not having one, and the image's `COPY` set is a thing that can be got wrong.
   * What that trades away is drift, so this is the assertion that pays for it:
   * ship a release without bumping the constant and the offer names a version
   * whose source nobody can fetch, which is a §13 failure that looks like
   * compliance.
   */
  {
    const instance = (await (await gget("/v1/instance")).json()) as {
      source?: { url?: unknown; version?: unknown };
    };
    check("an unauthenticated caller is offered the source", typeof instance.source?.url, "string");
    check("as an absolute URL, since it is followed from a browser", /^https?:\/\//.test(String(instance.source?.url)), true);
    check(
      "naming the version it is actually running",
      instance.source?.version,
      (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
    );
  }
  check(
    "and signing up is refused",
    await codeOf(await gpost("/v1/register", { name: "ada", password: "correct horse battery" })),
    [403, "registration_disabled"],
  );

  /* -- every public route is bounded ------------------------------------- */

  /*
   * **The assertion that proves the middleware is attached at all.** The
   * positional 256 KiB limit is registered *below* THE LINE and never runs for
   * these, so a route added above it without its own `bodyLimit` is an unbounded
   * read by an anonymous caller — and it passes every other check in this file
   * perfectly, because the only symptom is a 413 that does not happen.
   */
  const oversized = JSON.stringify({ name: "x".repeat(70_000) });
  for (const path of ["/v1/register", "/v1/register/confirm", "/v1/forgot", "/v1/reset"]) {
    check(
      `${path} bounds a body from a caller with no credential`,
      (
        await gapp.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversized,
        })
      ).status,
      413,
    );
  }

  /* -- open, no mail: a name and a password ------------------------------ */

  writeSetting(gdb, "registration.enabled", "true", null);
  {
    const answer = await gpost("/v1/register", { name: "ada", password: "correct horse battery" });
    const body = (await answer.json()) as { pending: boolean; token: string };
    check("without mail the account exists at once", [answer.status, body.pending], [201, false]);
    check("and it hands back a session", body.token.slice(0, 3), "rs_");
    check(
      "an address is refused where none could be confirmed",
      (await gpost("/v1/register", { name: "eve", password: "correct horse battery", email: "eve@example.com" })).status,
      400,
    );
    check(
      "a taken name is a 409, because a name is the login and has to be pickable",
      await codeOf(await gpost("/v1/register", { name: "ada", password: "correct horse battery" })),
      [409, "name_taken"],
    );
    check(
      "and recovery is refused rather than promised",
      await codeOf(await gpost("/v1/forgot", { email: "ada@example.com" })),
      [409, "mail_unconfigured"],
    );
  }

  /* -- with mail --------------------------------------------------------- */

  for (const [key, value] of [
    ["smtp.host", "mail.example"],
    ["smtp.username", "register@example.com"],
    ["smtp.password", "a mailbox password"],
    ["mail.from", "register@example.com"],
    ["mail.public_url", "https://cp.example"],
  ] as const) {
    writeSetting(gdb, key, value, null);
  }
  check(
    "mail becomes configured only once there is a credential to present",
    ((await (await gget("/v1/instance")).json()) as { mail: { configured: boolean } }).mail.configured,
    true,
  );

  {
    const answer = await gpost("/v1/register", {
      name: "carol",
      password: "correct horse battery",
      email: "Carol@Example.com",
    });
    check(
      "with mail nothing exists until the link is opened",
      [answer.status, ((await answer.json()) as { pending: boolean }).pending],
      [200, true],
    );
    check(
      "so there is no users row holding the name",
      Number(gdb.prepare("SELECT COUNT(*) AS n FROM users WHERE name='carol'").get()?.["n"] ?? -1),
      0,
    );
    check("and a confirmation was queued", mailed.at(-1)?.kind, "register");

    const token = tokenOf("register");
    check("the link carries its token in a fragment", token.slice(0, 3), "pr_");
    /*
     * The cross-package coupling: the control plane's SPA fallback answers a
     * JSON 404 for a last path segment that looks like a file, so a token
     * carrying a dot would render a blank page instead of a screen.
     */
    check("and a token can never look like a filename", /\./.test(token), false);

    const done = await gpost("/v1/register/confirm", { token });
    const doneBody = await done.text();
    check(
      "confirming creates the account",
      [done.status, (JSON.parse(doneBody) as { user: { name: string } }).user.name],
      [201, "carol"],
    );
    /*
     * **And hands back nothing you can authenticate with**, which is the whole
     * of the change and the half that fails silently: a route that mints a
     * session still answers 201 with the right name, so asserting the status and
     * the name passes while the link in a mailbox is a credential again.
     * Asserted against the raw body rather than a parsed field, because the
     * thing being refused is a token *anywhere* in it.
     */
    check("and no credential at all", /rs_|"token"|sessionId/.test(doneBody), false);
    check(
      "the account really is there to sign in to",
      Number(gdb.prepare("SELECT COUNT(*) AS n FROM users WHERE name='carol'").get()?.["n"] ?? -1),
      1,
    );
    check(
      "the address is confirmed by the link having been used",
      gdb.prepare("SELECT verified_at FROM user_emails WHERE email_folded='carol@example.com'").get()?.[
        "verified_at"
      ] !== null,
      true,
    );
    check(
      "and the link cannot be spent twice",
      await codeOf(await gpost("/v1/register/confirm", { token })),
      [409, "token_unusable"],
    );
  }

  /* -- signing up again is the resend ------------------------------------ */

  /*
   * **The route that used to do this is deleted, so the form has to.**
   * `POST /v1/register/resend` was the only way to get a second confirmation
   * mail, and a pending sign-up holds its login name for the full 24 hours — so
   * deleting the button without `nameTakenByAnother` would have answered
   * `409 name_taken` to the person whose own mail never arrived, about their own
   * sign-up, with no remedy for a day. All four halves are asserted, because
   * three of them pass on their own while the feature is broken: the same
   * address gets through, a *different* one still does not, the old link really
   * is dead, and the new one really does work.
   */
  {
    const first = await gpost("/v1/register", {
      name: "erin",
      password: "correct horse battery",
      email: "erin@example.com",
    });
    check("a first sign-up is pending", [first.status, ((await first.json()) as { pending: boolean }).pending], [200, true]);
    const firstToken = tokenOf("register");

    const again = await gpost("/v1/register", {
      name: "erin",
      password: "correct horse battery",
      email: "erin@example.com",
    });
    check("signing up again is not a 409 about yourself", again.status, 200);
    const secondToken = tokenOf("register");
    check("and it mints a new link", firstToken !== secondToken && secondToken.length > 0, true);
    check(
      "the link it replaces stops working",
      await codeOf(await gpost("/v1/register/confirm", { token: firstToken })),
      [409, "token_unusable"],
    );
    check(
      "a different address still cannot take a name somebody is holding",
      await codeOf(
        await gpost("/v1/register", {
          name: "erin",
          password: "correct horse battery",
          email: "not-erin@example.com",
        }),
      ),
      [409, "name_taken"],
    );
    check("and the newest link finishes the sign-up", (await gpost("/v1/register/confirm", { token: secondToken })).status, 201);
  }

  /*
   * The deletion itself — a route nobody calls that mails a link to any address
   * an anonymous caller names is not worth keeping for its own sake.
   *
   * **`401` and not `404`, and that is the stronger answer.** The path is no
   * longer in the public set above THE LINE, so `callerAuth` claims it before
   * any handler could: the positional gate failing closed for a route that no
   * longer exists is the same property that keeps a *new* private route private
   * by default. A 404 here would mean the path was still registered somewhere
   * above the gate.
   */
  check(
    "the resend route is gone, and gone from the public set with it",
    await codeOf(await gpost("/v1/register/resend", { email: "erin@example.com" })),
    [401, "missing_api_key"],
  );

  /* -- a taken address, which must not be an oracle ---------------------- */

  {
    const before = mailed.length;
    const answer = await gpost("/v1/register", {
      name: "mallory",
      password: "correct horse battery",
      email: "carol@example.com",
    });
    check(
      "a taken address answers exactly like a fresh one",
      [answer.status, ((await answer.json()) as { pending: boolean }).pending],
      [200, true],
    );
    check(
      "nothing was created for whoever asked",
      Number(gdb.prepare("SELECT COUNT(*) AS n FROM users WHERE name='mallory'").get()?.["n"] ?? -1),
      0,
    );
    /*
     * **Asserting only the 200 would pass while the service cheerfully mailed a
     * confirmation to the attacker.** What is asserted is who was written to,
     * and what kind of message it was.
     */
    check("and the real owner is warned instead", mailed.slice(before).map((m) => m.kind), ["register_notice"]);
    check("at their address, never the asker's", mailed.at(-1)?.to, "carol@example.com");
    // The request that triggered it was anonymous, so naming the account would
    // turn this message into the oracle the same-200 rule exists to close.
    check("and the notice never names the account", /carol/.test(mailed.at(-1)?.text ?? ""), false);
  }

  /* -- forgot, and the shape of its silence ------------------------------ */

  {
    const before = mailed.length;
    const unknown = await gpost("/v1/forgot", { email: "nobody@example.com" });
    const known = await gpost("/v1/forgot", { email: "carol@example.com" });
    /*
     * **Byte-identical**, not merely the same status: the body is the only thing
     * a stranger can read, and a difference of one field is the whole oracle.
     */
    check("an unknown address and a known one answer identically", await unknown.text(), await known.text());
    /*
     * ⚠ **The tick is the assertion's other half, not a workaround for it.**
     *
     * Everything that distinguishes the two branches — the owner lookup, the
     * token mint, the outbox insert — was moved behind `setImmediate`, because on
     * the request path it was a *timing* oracle: identical bodies, and one branch
     * paying three fsync'd transactions the other did not. So by the time the
     * response is readable there is deliberately nothing queued yet, and a driver
     * that checks without yielding is measuring the property rather than the mail.
     */
    await settled();
    check("but only one of them queued anything", mailed.length - before, 1);
    check("and it was the reset", mailed.at(-1)?.kind, "reset");

    const token = tokenOf("reset");
    /*
     * **A refused password does not burn the link.** Claiming first would mean
     * somebody who typed a short password needs a whole new email, which is the
     * dead end that makes people give up on a recovery flow.
     */
    check(
      "a weak password is refused",
      await codeOf(await gpost("/v1/reset", { token, newPassword: "short" })),
      [400, "weak_password"],
    );
    const set = await gpost("/v1/reset", { token, newPassword: "a whole new password" });
    check("and the link still works afterwards", set.status, 200);
    // Kept rather than swept, and reported rather than left silent: a mailbox
    // proves control of an address, not that the account was compromised.
    check("it reports the keys rather than silently sweeping them", ((await set.json()) as { apiKeysActive: number }).apiKeysActive, 0);
    check(
      "spending it twice is refused",
      await codeOf(await gpost("/v1/reset", { token, newPassword: "another whole password" })),
      [409, "token_unusable"],
    );
  }

  /* -- an invitation, which is a reset against an account with no password */

  {
    const answer = await gpost("/v1/admin/users", { name: "dave", email: "dave@example.com" }, op);
    const body = (await answer.json()) as { id: string; invited: boolean; password?: string };
    check("an invitation carries no secret at all", [answer.status, body.invited, body.password], [201, true, undefined]);
    check(
      "and the account has no password row for anybody to have seen",
      Number(gdb.prepare("SELECT COUNT(*) AS n FROM user_passwords WHERE user_id=?").get(body.id)?.["n"] ?? -1),
      0,
    );
    check("an invitation was queued", mailed.at(-1)?.kind, "invite");

    /*
     * The gap this closes: an invited address is **unverified**, and `/v1/reset`
     * refused unverified addresses — so every invitation would have failed. The
     * rule reads one way in both cases now: spending a link proves control of
     * the address it was mailed to.
     */
    const set = await gpost("/v1/reset", { token: tokenOf("invite"), newPassword: "daves own password" });
    check("the invitation sets a first password", set.status, 200);
    check(
      "and confirms the address by having been used",
      gdb.prepare("SELECT verified_at FROM user_emails WHERE email_folded='dave@example.com'").get()?.[
        "verified_at"
      ] !== null,
      true,
    );
  }

  /* -- a banned account cannot spend a link ------------------------------ */

  {
    const made = (await (await gpost("/v1/admin/users", { name: "erin", email: "erin@example.com" }, op)).json()) as {
      id: string;
    };
    const token = tokenOf("invite");
    await gpost(`/v1/admin/users/${made.id}/disable`, {}, op);
    /*
     * `/v1/reset` sits above THE LINE and has no caller, so it reads
     * `disabled_at` itself — **and** `disable` burns the tokens. Two independent
     * answers, because a sweep is the half somebody forgets to call, which is
     * the lesson `burnUserCodes` already paid for one table over.
     */
    check(
      "a banned account's outstanding link is dead",
      (await gpost("/v1/reset", { token, newPassword: "erins own password" })).status !== 200,
      true,
    );
  }

  /* -- the settings projection ------------------------------------------- */

  {
    const raw = await (await gget("/v1/admin/settings", op)).text();
    /*
     * **Checking `settings.find(...).value === null` would pass while the value
     * leaked through `envValue`.** The whole response is searched instead.
     */
    check("the SMTP password appears nowhere in the response", raw.includes("a mailbox password"), false);
    const parsed = JSON.parse(raw) as {
      settings: { key: string; value: string | null; set?: boolean; source: string }[];
    };
    const password = parsed.settings.find((entry) => entry.key === "smtp.password");
    check(
      "it is reported as set, without its value",
      [password?.value, password?.set, password?.source],
      [null, true, "database"],
    );
    /*
     * A screen that draws only what exists cannot offer to set the rest.
     *
     * Counted from `SETTING_KEYS` rather than written out, so adding a key
     * cannot make this pass by having been updated to the wrong number — the
     * rule `webcheck` states for `visibleSections`. It was the literal `13`, and
     * `machines.per_user` is what made that a failing test rather than a stale
     * comment.
     */
    check("every key is present even when it has no value", parsed.settings.length, SETTING_KEYS.length);
    check(
      "an unknown key is refused by name",
      await codeOf(
        await gapp.request("/v1/admin/settings", {
          method: "PUT",
          headers: op,
          body: JSON.stringify({ set: { "smtp.hostname": "x" } }),
        }),
      ),
      [400, "unknown_setting"],
    );
    check("and nobody without a credential can read them", (await gget("/v1/admin/settings")).status, 401);

    /* -- rotating the key that mints every token in the fleet ------------- */

    /*
     * ⚠ **`schema.sql` described this rotation and no code could perform it.**
     * The table is plural and `retired_at` exists "so a rotation can overlap",
     * with two readers of that column and **no writer anywhere** — the same shape
     * `api_keys.revoked_at` is named for, on the fleet's signing key. The remedy
     * for a leaked database was hand-editing SQLite inside a `read_only`
     * container.
     */
    const keysNow = async (): Promise<{ kid: string; retiredAt: number | null }[]> =>
      ((await (await gget("/v1/admin/signing-keys", op)).json()) as {
        keys: { kid: string; retiredAt: number | null }[];
      }).keys;

    const before = await keysNow();
    check("an instance starts with one active key", before.filter((key) => key.retiredAt === null).length, 1);

    /*
     * **The last active key may not be retired**, and this is the refusal that
     * makes the feature safe to have at all: with none, `POST /v1/tokens` fails
     * for every machine *and* nothing can mint a replacement, because
     * `ensureSigningKey` runs at startup and this service does not restart
     * itself. One request would take the fleet off the network.
     */
    const lonely = await gapp.request(`/v1/admin/signing-keys/${before[0]?.kid ?? "k_none"}`, {
      method: "DELETE",
      headers: op,
    });
    check("the only active key cannot be retired", await codeOf(lonely), [409, "last_active"]);

    const minted = await gpost("/v1/admin/signing-keys", {}, op);
    check("minting a second one is a 201", minted.status, 201);
    const after = await keysNow();
    check("and both are active, which is what makes the overlap survivable", after.filter((key) => key.retiredAt === null).length, 2);
    /*
     * The newest signs and **both are published**. That pair is the whole
     * rotation: a daemon captures the key set once at enrollment and never asks
     * again, so a swap would leave every already-enrolled machine verifying
     * against a key that no longer signs — i.e. the fleet unreachable until each
     * host is visited.
     */
    const published = ((await (await gget("/v1/jwks")).json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
    check("both public halves are handed out", published.length, 2);
    report(
      "with the newest first, which is the one that signs",
      published[0] === after.find((key) => key.retiredAt === null)?.kid,
      `jwks: ${published.join(", ")}`,
    );

    /*
     * And now the old one can go — which is the act that was impossible before,
     * and the reason the refusal above is a state rather than a rule about the
     * request.
     */
    const oldest = before[0]?.kid ?? "";
    check("with a second key, the first may be retired", (await gapp.request(`/v1/admin/signing-keys/${oldest}`, { method: "DELETE", headers: op })).status, 200);
    const finally_ = await keysNow();
    check("leaving one active and one retired", [
      finally_.filter((key) => key.retiredAt === null).length,
      finally_.filter((key) => key.retiredAt !== null).length,
    ], [1, 1]);
    check("a retired key is no longer published", ((await (await gget("/v1/jwks")).json()) as { keys: unknown[] }).keys.length, 1);
    check("and retiring it again is a 404 rather than a second success", await codeOf(await gapp.request(`/v1/admin/signing-keys/${oldest}`, { method: "DELETE", headers: op })), [404, "key_not_found"]);
    check("nobody without a credential may list them", (await gget("/v1/admin/signing-keys")).status, 401);

    /*
     * **Whether mail is *arriving*, which nothing on this route used to say.**
     *
     * `configured` answers "are the settings complete" and was the whole of it,
     * so an instance whose provider had started rejecting its sender reported a
     * healthy configuration for ever: the only record of a failed delivery was a
     * `console.error` in a container with rotating logs, and the breaker — five
     * consecutive failures, dialling stopped — was in memory with `paused()`
     * called by nothing outside this driver.
     *
     * The shape is asserted rather than a failure being manufactured, because the
     * database this section shares is the one every later section reads.
     */
    const delivery = (JSON.parse(raw) as { mail: { delivery?: Record<string, unknown> } }).mail.delivery;
    check(
      "delivery health rides the same object as the configuration",
      delivery === undefined
        ? "absent"
        : [typeof delivery["pending"], typeof delivery["failed"], typeof delivery["paused"]].join(","),
      "number,number,boolean",
    );
  }

  /* -- writing settings, clearing them, and all-or-nothing ---------------- */

  {
    /*
     * The projection above is the read; **nothing drove the write**, which is
     * where the two verbs and the transaction are. Three properties, and the
     * third is the one with a transaction behind it:
     *
     *   - `set` writes, and the value comes back reported as `database` — the
     *     provenance rule asserted through the route rather than through
     *     `readSetting` alone.
     *   - `clear` is its own verb rather than `set` with `""`, because an empty
     *     string here is a *value* ("this server wants no username") and a clear
     *     that wrote one would shadow the environment for ever.
     *   - a batch naming one key nobody has writes **nothing**. Every key is
     *     validated before `BEGIN`, so the good key in front of the bad one is
     *     the case that fails if somebody ever writes as they validate — and it
     *     is silent, because the 400 looks exactly the same either way.
     */
    const put = (body: unknown): Promise<Response> =>
      Promise.resolve(gapp.request("/v1/admin/settings", { method: "PUT", headers: op, body: JSON.stringify(body) }));

    const wrote = await put({ set: { "mail.from_name": "Reemoat" } });
    check("a write lands, and says the database is where it came from", [wrote.status, readSetting(gdb, "mail.from_name")], [
      200,
      { value: "Reemoat", source: "database" },
    ]);
    const cleared = await put({ clear: ["mail.from_name"] });
    check("clearing is its own verb, and leaves no row behind", [
      cleared.status,
      readSetting(gdb, "mail.from_name").source === "database",
    ], [200, false]);

    const mixed = await put({ set: { "mail.from_name": "half applied", "smtp.hostname": "x" } });
    check("a batch naming a key nobody has is refused by name", await codeOf(mixed), [400, "unknown_setting"]);
    check(
      "and the good key in front of it was not written",
      readSetting(gdb, "mail.from_name").source === "database",
      false,
    );
    check(
      "a value the key will not take is refused too, and writes nothing",
      [
        (await codeOf(await put({ set: { "mail.from_name": "kept", "smtp.port": "70000" } })))[0],
        readSetting(gdb, "mail.from_name").source === "database",
      ],
      [400, false],
    );
    check("and clearing something nobody set is not an error", (await put({ clear: ["mail.reply_to"] })).status, 200);
  }

  /* -- the partial unique index ------------------------------------------ */

  {
    /*
     * **A plain UNIQUE index here would be a squatting denial of service**:
     * anybody could reserve any address by merely *claiming* it, permanently
     * blocking the real owner, from an anonymous route. Scoping uniqueness to
     * verified rows says an unverified claim reserves nothing — and a check that
     * inserts only one row passes either way, which is why two go in.
     */
    gdb.prepare("INSERT INTO users (id,name,is_admin,created_at) VALUES ('u_sq1','sq1',0,0)").run();
    gdb.prepare("INSERT INTO users (id,name,is_admin,created_at) VALUES ('u_sq2','sq2',0,0)").run();
    let bothClaimed = true;
    try {
      gdb
        .prepare("INSERT INTO user_emails (user_id,email,email_folded,verified_at,updated_at) VALUES (?,?,?,NULL,0)")
        .run("u_sq1", "squat@e", "squat@e");
      gdb
        .prepare("INSERT INTO user_emails (user_id,email,email_folded,verified_at,updated_at) VALUES (?,?,?,NULL,0)")
        .run("u_sq2", "squat@e", "squat@e");
    } catch {
      bothClaimed = false;
    }
    check("two accounts may hold the same unconfirmed address", bothClaimed, true);
    gdb.prepare("UPDATE user_emails SET verified_at = 1 WHERE user_id = 'u_sq1'").run();
    let refused = false;
    try {
      gdb.prepare("UPDATE user_emails SET verified_at = 1 WHERE user_id = 'u_sq2'").run();
    } catch {
      refused = true;
    }
    check("but only one may prove it", refused, true);
  }

  /* -- fixtures no route can produce ------------------------------------- *
   *
   * An account with an address and **no password** is the shape three of the
   * cases below are about, and the only route that creates one is the
   * invitation. These are written directly because what is being asserted is a
   * route's behaviour *in* that state rather than the state's provenance.
   * ----------------------------------------------------------------------- */

  const gput = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
    Promise.resolve(gapp.request(path, { method: "PUT", headers, body: JSON.stringify(body) }));

  const seedUser = (id: string, name: string, email: string | null, verified: boolean): string => {
    gdb.prepare("INSERT INTO users (id,name,is_admin,created_at) VALUES (?,?,0,?)").run(id, name, Date.now());
    if (email !== null) {
      gdb
        .prepare("INSERT INTO user_emails (user_id,email,email_folded,verified_at,updated_at) VALUES (?,?,?,?,?)")
        .run(id, email, foldEmail(email), verified ? Date.now() : null, Date.now());
    }
    return id;
  };
  const seedKey = (userId: string): Record<string, string> => {
    const minted = newApiKey();
    gdb
      .prepare("INSERT INTO api_keys (id,user_id,prefix,key_hash,created_at) VALUES (?,?,?,?,?)")
      .run(newId("ak"), userId, minted.prefix, minted.hash, Date.now());
    return { authorization: `Bearer ${minted.key}`, "content-type": "application/json" };
  };

  /* -- inviting somebody again ------------------------------------------- */

  /*
   * **The route that stops an invited account becoming unreachable.** Such an
   * account has no password row and an *unverified* address, so `POST /v1/forgot`
   * mails nothing (`verifiedOwnerOf` is what it looks an address up by), the
   * admin reset and key-mint routes are deleted, and `POST /v1/admin/users`
   * answers `409 user_exists` — every door shut at once if the first invitation
   * was never delivered. All four answers are asserted, because the three
   * refusals are what stop this becoming a way to mint a password-setting link
   * for an account somebody is already using.
   */
  {
    const created = (await (await gpost("/v1/admin/users", { name: "karl", email: "karl@example.com" }, op)).json()) as {
      id: string;
    };
    const firstToken = tokenOf("invite");
    const before = mailed.length;
    const again = await gpost(`/v1/admin/users/${created.id}/invite`, {}, op);
    check(
      "an invited account can be invited again",
      [again.status, ((await again.json()) as { mailQueued: boolean }).mailQueued],
      [200, true],
    );
    check("and the message is an invitation", mailed.slice(before).map((message) => message.kind), ["invite"]);
    // One live link per account, `mintEmailToken`'s rule: a resend that left two
    // working links would be two ways into one account.
    check(
      "the link it replaces stops working",
      await codeOf(await gpost("/v1/reset", { token: firstToken, newPassword: "karls own password" })),
      [409, "token_unusable"],
    );

    const carol = gdb.prepare("SELECT id FROM users WHERE name = 'carol'").get();
    check(
      "somebody who already has a password is refused, and told which",
      await codeOf(await gpost(`/v1/admin/users/${String(carol?.["id"])}/invite`, {}, op)),
      [409, "user_has_password"],
    );
    check(
      "so is an account with no address to invite",
      await codeOf(await gpost(`/v1/admin/users/${seedUser("u_mute", "mute", null, false)}/invite`, {}, op)),
      [409, "user_has_no_email"],
    );
    check(
      "and an id nobody has is a 404",
      await codeOf(await gpost("/v1/admin/users/u_nobody/invite", {}, op)),
      [404, "user_not_found"],
    );
  }

  /* -- the delivery log --------------------------------------------------- */

  {
    /*
     * **Never `body`.** A queued message holds a live one-time link, so a
     * delivery log carrying it would be a place an admin could spend somebody
     * else's password reset. Asserted over the whole response text *and* over the
     * keys of every row, and only after checking there are rows at all — the
     * absence of a field in an empty list says nothing.
     */
    const raw = await (await gget("/v1/admin/mail", op)).text();
    const log = JSON.parse(raw) as { total: number; deliveries: Record<string, unknown>[] };
    report("there is something in the log to leak", log.deliveries.length > 0, `${log.total} deliveries`);
    check("no row carries a body", log.deliveries.some((row) => "body" in row), false);
    // The key, not the word: `Somebody tried to sign up with your address` is a
    // real subject in this log, and a bare substring search is green only until
    // somebody writes a template that contains it.
    check("and no such key appears anywhere in the response", raw.includes('"body"'), false);
    /*
     * It is a disclosure surface either way — a registration delivery names an
     * address belonging to somebody who is not a user and may never become one —
     * which is why `requireAdmin` is the whole access rule and why the refusal is
     * asserted beside the shape.
     */
    check(
      "and somebody who is not an admin cannot read it",
      await codeOf(await gget("/v1/admin/mail", seedKey(seedUser("u_looker", "looker", null, false)))),
      [403, "forbidden"],
    );
  }

  /* -- trying a failed message again --------------------------------------- */

  {
    /*
     * The only write on the delivery screen, and it had no case at all.
     *
     * **`attempts = 0` is the half that decides whether the button does
     * anything.** `recordMailFailure` gives up at `MAX_ATTEMPTS`, so a row put
     * back on the queue with its counter left at eight is claimed once, fails
     * once and is terminal again — a control that answers `200 {queued: true}`
     * and changes nothing, on the screen an operator reaches for *after* fixing
     * the setting that broke delivery. Asserted as the whole row rather than as
     * the status, because the status is identical either way.
     */
    const retried = String(
      enqueueMail(gdb, {
        to: "ops@example.com",
        kind: "test",
        subject: "A test message",
        text: "https://cp.example/",
        html: "<a href='https://cp.example/'>hi</a>",
        notAfter: Date.now() + 60 * 60 * 1000,
      }),
    );
    gdb
      .prepare("UPDATE mail_outbox SET attempts = 8, failed_at = ?, last_error = 'greeting: nothing came back' WHERE id = ?")
      .run(Date.now(), retried);

    const answer = await gpost(`/v1/admin/mail/${retried}/retry`, {}, op);
    check(
      "a failed message can be put back on the queue",
      [answer.status, ((await answer.json()) as { queued: boolean }).queued],
      [200, true],
    );
    const row = (gdb
      .prepare("SELECT attempts, failed_at, last_error, next_at FROM mail_outbox WHERE id = ?")
      .get(retried) ?? {}) as Record<string, unknown>;
    check(
      "with its counter, its failure and the server's last words all cleared",
      [Number(row["attempts"]), row["failed_at"], row["last_error"]],
      [0, null, null],
    );
    report(
      "and due now rather than at the back of the backoff curve",
      Number(row["next_at"]) <= Date.now(),
      `next_at is ${Date.now() - Number(row["next_at"])}ms ago`,
    );

    /*
     * The refusal, and the reason it is not a 200: a row whose `body` has been
     * swept holds no message to send, so answering "queued" would claim
     * something was on its way that never will be.
     */
    gdb.prepare("UPDATE mail_outbox SET body = NULL WHERE id = ?").run(retried);
    check(
      "a message whose body has been swept cannot be sent again",
      await codeOf(await gpost(`/v1/admin/mail/${retried}/retry`, {}, op)),
      [409, "mail_expired"],
    );
    check(
      "and an id nobody has is a 404",
      await codeOf(await gpost("/v1/admin/mail/mo_nobody/retry", {}, op)),
      [404, "mail_not_found"],
    );
  }

  /* -- the admin's own test message --------------------------------------- */

  {
    /*
     * **It enqueues and answers 202.** The temptation is real — an operator wants
     * the SMTP transcript *now* — and it is the worst place to allow a
     * synchronous send: up to ninety seconds against an admin-supplied host, on
     * the process carrying every relay tunnel in the fleet. So the elapsed time
     * is part of the assertion rather than a comment about it.
     */
    const started = Date.now();
    const answer = await gpost("/v1/admin/settings/test", { to: "ops@example.com" }, op);
    check(
      "a test message is queued rather than sent",
      [answer.status, mailed.at(-1)?.kind, mailed.at(-1)?.to],
      [202, "test", "ops@example.com"],
    );
    report("and the route answered without waiting for a socket", Date.now() - started < 1_000, `${Date.now() - started}ms`);
  }

  /* -- changing your address kills the reset pointed at the old one -------- */

  {
    /*
     * Two independent answers to one question, which is `burnUserCodes`' lesson
     * applied to a third table: `/v1/reset` compares the token's address against
     * the account's current one, **and** `PUT /v1/me/email` burns the token
     * outright. Asserting only the 409 passes with the sweep deleted, so the row
     * is read as well — `used_from` is the only forensic trail there is, and a
     * burn recorded under the wrong reason is indistinguishable from one that
     * never happened.
     */
    const mona = seedUser("u_mona", "mona", "mona@example.com", true);
    const monaKey = seedKey(mona);
    await gpost("/v1/forgot", { email: "mona@example.com" });
    await settled();
    const token = tokenOf("reset");
    check("a reset link was mailed to the address on the account", token.length > 0, true);

    const moved = await gput("/v1/me/email", { email: "mona2@example.com" }, monaKey);
    check("the address is changed, unverified", [moved.status, ((await moved.json()) as { verified: boolean }).verified], [200, false]);
    check(
      "the outstanding reset is burned, and says why",
      gdb
        .prepare("SELECT used_from FROM user_email_tokens WHERE user_id = ? AND purpose = 'reset' ORDER BY created_at DESC LIMIT 1")
        .get(mona)?.["used_from"],
      "email_changed",
    );
    check(
      "so spending it resets nothing",
      await codeOf(await gpost("/v1/reset", { token, newPassword: "monas own password" })),
      [409, "token_unusable"],
    );
  }

  /* -- confirming the address on your own account -------------------------- */

  {
    /*
     * **`POST /v1/me/email/verify` had no case at all**, and it is the only
     * thing that turns a claimed address into a recoverable one: `verifiedOwnerOf`
     * reads `verified_at IS NOT NULL`, so until this route runs, `POST
     * /v1/forgot` mails nothing and the account has no way back. Three arms,
     * and each is a different table:
     *
     *   - the happy path, asserted on `GET /v1/me` rather than on the route's
     *     own body, because the field a client reads and the column this writes
     *     are two things and the response would agree with itself either way;
     *   - the spent link, which is `claimEmailToken`'s conditional `UPDATE`
     *     doing its job — a route that read the token and then wrote would let
     *     two taps on a phone through;
     *   - **`409 email_taken`**, which is the partial unique index surfacing
     *     through `isUniqueViolation`. Two accounts may hold one address as an
     *     unverified claim — refusing that would answer "does this address have
     *     an account here" to any signed-in caller — and exactly one may prove
     *     it. That arm is reachable only by driving two accounts at one address,
     *     which is why it is not a smaller case.
     */
    const nate = seedUser("u_nate", "nate", null, false);
    const nateKey = seedKey(nate);
    const claimed = await gput("/v1/me/email", { email: "Nate@Example.com" }, nateKey);
    check(
      "adding an address stores it unverified and mails a link",
      [claimed.status, ((await claimed.json()) as { verified: boolean }).verified, mailed.at(-1)?.kind],
      [200, false, "verify"],
    );

    const link = tokenOf("verify");
    const confirmed = await gpost("/v1/me/email/verify", { token: link }, nateKey);
    check(
      "opening it confirms the address",
      [confirmed.status, ((await confirmed.json()) as { verified: boolean }).verified],
      [200, true],
    );
    check(
      "and the account now reports an address it can be recovered from",
      ((await (await gget("/v1/me", nateKey)).json()) as { email: string; emailVerified: boolean }).emailVerified,
      true,
    );
    check(
      "the link cannot be spent twice",
      await codeOf(await gpost("/v1/me/email/verify", { token: link }, nateKey)),
      [409, "token_unusable"],
    );

    const olga = seedUser("u_olga", "olga", null, false);
    const olgaKey = seedKey(olga);
    const alsoClaimed = await gput("/v1/me/email", { email: "nate@example.com" }, olgaKey);
    check("a second account may claim an address somebody else has proved", alsoClaimed.status, 200);
    check(
      "but proving it is refused, and named",
      await codeOf(await gpost("/v1/me/email/verify", { token: tokenOf("verify") }, olgaKey)),
      [409, "email_taken"],
    );
    /*
     * The mirror of `/v1/reset`'s own second line, and the reason this route now
     * claims its link **inside** a transaction. Out in autocommit the claim spent
     * the link and `markVerified` then tripped the partial unique index, so the
     * `409` above arrived over a link that was **already burned** — and the person
     * could not retry even once the other account's claim was resolved. For an
     * invited account that link is the only credential there is.
     *
     * Without this the repair is unasserted: put the claim back above the `BEGIN`
     * and every other line in this block stays green.
     */
    check(
      "and that link is still unspent, because the claim rolled back with it",
      gdb.prepare("SELECT used_at FROM user_email_tokens WHERE user_id = ? AND purpose = 'verify'").get(olga)?.[
        "used_at"
      ],
      null,
    );
    check(
      "and the first owner still holds it",
      String(
        gdb.prepare("SELECT user_id FROM user_emails WHERE email_folded = 'nate@example.com' AND verified_at IS NOT NULL").get()?.[
          "user_id"
        ],
      ),
      nate,
    );
  }

  /* -- repointing the reset channel needs the password, always ------------- */

  {
    /*
     * **A borrowed session must not become permanent ownership**, and this route
     * was the one hole left in that rule.
     *
     * `PUT /v1/me/email` asked for the current password only when the account
     * already had a *verified* address — so for every account without one, a
     * stolen session bearer ran the whole chain: repoint the address, confirm it
     * with the same session, `/v1/forgot`, `/v1/reset`, and out comes a password
     * the thief chose plus a `revokeAllSessions` that evicts the real owner. The
     * bootstrap admin is created with no `user_emails` row at all, so the fleet's
     * founding account was in exactly that state.
     *
     * Asserted in the state that used to be exempt — **no address row** — because
     * the guarded state was never the broken one. The pair matters: the refusal
     * names the field, and the same request with the password lands, so this
     * cannot pass by the route being broken outright.
     */
    const pia = seedUser("u_pia", "pia", null, false);
    const piaPassword = "pia's own long password";
    gdb
      .prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?,?,?)")
      .run(pia, await hashPassword(piaPassword, "authenticated"), Date.now());
    const piaKey = seedKey(pia);

    check(
      "adding a first address needs the current password too",
      await codeOf(await gput("/v1/me/email", { email: "pia@example.com" }, piaKey)),
      [400, "bad_request"],
    );
    check(
      "a wrong one is refused as a password rather than as a body",
      await codeOf(
        await gput("/v1/me/email", { email: "pia@example.com", currentPassword: "not it" }, piaKey),
      ),
      [401, "invalid_password"],
    );
    check(
      "and the address is unchanged, so nothing was half-applied",
      gdb.prepare("SELECT email FROM user_emails WHERE user_id = ?").get(pia),
      undefined,
    );
    check(
      "with the password it lands",
      (await gput("/v1/me/email", { email: "pia@example.com", currentPassword: piaPassword }, piaKey)).status,
      200,
    );

    /*
     * The migration exemption, unchanged and asserted so narrowing it later is a
     * decision rather than an accident: an account with **no password row** is
     * proved by the API key it is holding, because requiring a password nobody
     * ever set would strand it. Safe because no session can exist without that
     * row — every `mintSession` call site requires or creates one — so only a
     * key reaches this arm, and a key is already full authority.
     */
    const wren = seedUser("u_wren", "wren", null, false);
    check(
      "an account with no password row is still let through on its key alone",
      (await gput("/v1/me/email", { email: "wren@example.com" }, seedKey(wren))).status,
      200,
    );
  }

  /* -- a reset that rolls back leaves the link spendable ------------------- */

  {
    /*
     * `claimEmailToken` is the conditional UPDATE that makes a link single-use,
     * and it used to run **above** the transaction — so the `ROLLBACK` on the
     * `email_taken` arm undid the password, the session sweep and the
     * verification while the link stayed burned. The person it strands is an
     * invitee, for whom that link is the only credential there is.
     *
     * Driven through the reachable shape: two accounts holding one address as an
     * unverified claim, one of them proving it *after* the other's link was
     * minted. The second assertion is the whole point — the first would pass with
     * the claim left where it was.
     */
    const rosa = seedUser("u_rosa", "rosa", "shared@example.com", false);
    const stan = seedUser("u_stan", "stan", "shared@example.com", false);
    const link = mintEmailToken(gdb, rosa, "reset", "shared@example.com", 60 * 60 * 1000).token;
    gdb.prepare("UPDATE user_emails SET verified_at = ? WHERE user_id = ?").run(Date.now(), stan);

    check(
      "a reset onto an address somebody else has proved is refused",
      await codeOf(await gpost("/v1/reset", { token: link, newPassword: "rosa's fine password" })),
      [409, "email_taken"],
    );
    check(
      "and the link is still unspent, because the claim rolled back with everything else",
      gdb.prepare("SELECT used_at FROM user_email_tokens WHERE user_id = ? AND purpose = 'reset'").get(rosa)?.[
        "used_at"
      ],
      null,
    );
    check(
      "so nothing was written for the account either",
      gdb.prepare("SELECT COUNT(*) AS n FROM user_passwords WHERE user_id = ?").get(rosa)?.["n"],
      0,
    );
  }

  /* -- closing registration closes it for links already in flight ---------- */

  {
    /*
     * A pending sign-up lives 24 hours, so without the second check an admin who
     * turns registration off — the remedy somebody reaches for while being abused
     * — would watch accounts appear for the rest of the day, from links already
     * in mailboxes. Driven by writing the setting on the live app, because there
     * is no route that closes registration and then confirms.
     *
     * Re-opened and confirmed again afterwards, which is the half that says the
     * refusal was **the switch and not the link**: a 403 that had also burned the
     * token would leave somebody who signed up minutes before an unrelated close
     * with no way back.
     */
    const asked = await gpost("/v1/register", {
      name: "judy",
      password: "correct horse battery",
      email: "judy@example.com",
    });
    check("a sign-up is pending", asked.status, 200);
    const token = tokenOf("register");

    writeSetting(gdb, "registration.enabled", "false", null);
    check(
      "confirming is refused while sign-ups are closed, and named",
      await codeOf(await gpost("/v1/register/confirm", { token })),
      [403, "registration_disabled"],
    );
    writeSetting(gdb, "registration.enabled", "true", null);
    check("and the same link finishes the sign-up once they are open again", (await gpost("/v1/register/confirm", { token })).status, 201);
  }

  /* -- a weak password does not spend the guessing counter ----------------- */

  {
    /*
     * `resetKey` bounds *guessing a token*, and by the time the policy check runs
     * the caller has produced a real, live, unspent one for an account that
     * exists — they are not guessing, whatever happens to the password next.
     * Counted after the claim instead, five tries at a 12-character minimum
     * answered `429` and put the person behind a doubling block while holding a
     * token that expires in an hour: the remedy refused by the mechanism that
     * exists to protect it, on the one route that *is* the recovery.
     *
     * One past the threshold rather than exactly it, because `check` runs before
     * `fail`: the attempt that trips the block is itself allowed, so a run of
     * exactly `threshold` refusals would be green under the old ordering too.
     */
    seedUser("u_iris", "iris", "iris@example.com", true);
    await gpost("/v1/forgot", { email: "iris@example.com" });
    await settled();
    const token = tokenOf("reset");

    const refusals: [number, string][] = [];
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE.threshold; attempt += 1) {
      refusals.push(await codeOf(await gpost("/v1/reset", { token, newPassword: "short" })));
    }
    check(
      "every weak password is refused as weak rather than as guessing",
      refusals,
      Array.from({ length: DEFAULT_THROTTLE.threshold + 1 }, () => [400, "weak_password"]),
    );
    check(
      "and the link still works afterwards, from the same address",
      (await gpost("/v1/reset", { token, newPassword: "iris own new password" })).status,
      200,
    );
  }

  /* -- and a real token does not un-spend it either ------------------------- */

  {
    /*
     * The mirror of the case above, and the reason the fix is "record only on a
     * bad token" rather than "succeed once the token is real".
     *
     * `succeed()` placed above the policy check makes the weak-password case
     * green and opens something worse: the token is not consumed until
     * `claimEmailToken`, so a live one can be replayed with a deliberately weak
     * password to **reset the counter at will** — and anybody can obtain one by
     * calling `/v1/forgot` for their own account. The bound on guessing at
     * *other* people's links is then permanently lifted from that address.
     *
     * So: spend the budget entirely on unknown tokens, interleaving replays of a
     * real one, and assert the block still arrives. Under the `succeed()` shape
     * every replay resets the counter and the last guess answers 409 instead.
     */
    seedUser("u_juno", "juno", "juno@example.com", true);
    await gpost("/v1/forgot", { email: "juno@example.com" });
    await settled();
    const live = tokenOf("reset");

    let blocked = false;
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE.threshold; attempt += 1) {
      // A replay of a token that really is live, refused for the password alone.
      await gpost("/v1/reset", { token: live, newPassword: "short" });
      const [status] = await codeOf(
        await gpost("/v1/reset", { token: `et_${"z".repeat(24)}${attempt}`, newPassword: "a fine long password" }),
      );
      if (status === 429) blocked = true;
    }
    check("replaying a live link does not un-spend the guessing counter", blocked, true);
    /*
     * Read off the row rather than by spending the link: the address is behind
     * the block by now, which is the whole point of the case above, so a `200`
     * here is not reachable and its absence would prove nothing.
     */
    check(
      "and the replays never claimed it — a refused password leaves the link alive",
      Number(
        gdb
          .prepare(
            "SELECT COUNT(*) AS n FROM user_email_tokens WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL",
          )
          .get("u_juno")?.["n"] ?? 0,
      ),
      1,
    );
  }

  /* -- one notice per address per day -------------------------------------- */

  {
    /*
     * The `register_notice` is the vector the "a taken address answers the same
     * 200" decision creates: mail to a **third party** on an **anonymous**
     * request. Its bound was written down in `schema.sql`'s index, in
     * `sentRecently`'s docblock and in CLAUDE.md's Bounds table, and implemented
     * nowhere — `sentRecently` had no callers, so the only limit was the shared
     * three-an-hour, which a restart cleared because that throttle is in memory
     * while this is a query against the outbox itself.
     *
     * Two sign-ups against one owner, and the assertion is the **count**: both
     * arms answer identically either way, so a status check alone is green while
     * somebody's mailbox fills up.
     */
    seedUser("u_frank", "frank", "frank@example.com", true);
    const before = mailed.length;
    const first = await gpost("/v1/register", { name: "grace", password: "correct horse battery", email: "frank@example.com" });
    const second = await gpost("/v1/register", { name: "heidi", password: "correct horse battery", email: "frank@example.com" });
    check("both sign-ups answer like a fresh address", [first.status, second.status], [200, 200]);
    check(
      "and the real owner is told once, not twice",
      mailed.slice(before).filter((message) => message.kind === "register_notice").length,
      1,
    );
  }

  /* -- a domain allowlist, which had only ever run on its open arm ---------- */

  {
    /*
     * `parseEmailDomains` and `emailDomainAllowed` are reached from exactly one
     * place — `POST /v1/register` — and **no driver had ever written
     * `registration.email_domains`**, so the pair ran its permissive arm
     * (`domains.length === 0` → allow) on every register case in this file and
     * the refusal was code nothing executed. Driven by writing the setting on
     * the live app, because there is no route that closes registration to a
     * domain and then signs somebody up.
     *
     * **The comma-only value is the third arm and the reason this is not two
     * cases.** `","` splits into two empty parts; a parser that kept them makes
     * the list `["", ""]`, which matches no domain at all — so a stray comma in
     * a settings field would lock every sign-up out of the instance, and the
     * mirror mistake (treating any non-empty string as "there is a list") would
     * open it. `filter` is what makes it mean "any", identically to absence.
     */
    writeSetting(gdb, "registration.email_domains", "Example.org, @example.net", null);

    const refusedDomain = await gpost("/v1/register", {
      name: "quinn",
      password: "correct horse battery",
      email: "quinn@example.com",
    });
    const refusedShape = await gpost("/v1/register", {
      name: "quinn",
      password: "correct horse battery",
      email: "not an address",
    });
    /*
     * The same status *and the same code* as a malformed address, deliberately:
     * the allowlist is not published, and a code of its own would tell a
     * stranger which employer this instance belongs to.
     */
    check("an address outside the allowlist is refused", await codeOf(refusedDomain), [400, "bad_request"]);
    check("indistinguishably from one that is not an address", await codeOf(refusedShape), await codeOf(refusedDomain));
    check(
      "and the refusal names no domain",
      /example\.(org|net)/i.test(
        ((await refusedDomain.clone().json()) as { error?: { message?: string } }).error?.message ?? "",
      ),
      false,
    );

    // Case-folded on both sides, and a leading `@` tolerated, because both are
    // what somebody types into that field.
    check(
      "an address inside it is accepted, whatever case either side was typed in",
      (await gpost("/v1/register", { name: "quinn", password: "correct horse battery", email: "quinn@EXAMPLE.org" }))
        .status,
      200,
    );
    check(
      "and so is one under an entry written with an @",
      (await gpost("/v1/register", { name: "rita", password: "correct horse battery", email: "rita@example.net" }))
        .status,
      200,
    );

    writeSetting(gdb, "registration.email_domains", ",", null);
    check(
      "a value that is nothing but a comma is an empty list, which admits everything",
      (await gpost("/v1/register", { name: "sam", password: "correct horse battery", email: "sam@example.com" }))
        .status,
      200,
    );
    // Put back, or every register case after this one is answering a different
    // question from the one it was written to ask.
    clearSetting(gdb, "registration.email_domains");
  }

  /* -- a full outbox is not an oracle either -------------------------------- */

  {
    /*
     * **The two register arms have to answer identically under every condition an
     * attacker can create, and a full outbox is one of them.** The fresh arm
     * answered `503 overloaded` while the taken arm answered `200`, so filling
     * the queue turned the enumeration oracle back on — in the one route that
     * spends a whole branch and a whole scrypt closing it. The pending row is
     * already written and signing up again re-sends it, so swallowing the refusal
     * costs the caller nothing.
     *
     * `mailed` is asserted unchanged as well, because two 200s with the mail
     * going out anyway would mean the queue was never full and the case proved
     * nothing.
     */
    seedUser("u_paula", "paula", "paula@example.com", true);
    const fill = gdb.prepare(
      "INSERT INTO mail_outbox (id,to_address,to_folded,kind,subject,body,created_at,not_after,next_at,attempts) " +
        "VALUES (?,?,?,?,?,?,?,?,?,0)",
    );
    const at = Date.now();
    for (let index = 0; index < MAX_OUTBOX_PENDING; index += 1) {
      fill.run(`mo_fill_${index}`, "fill@example.com", "fill@example.com", "test", "filler", "{}", at, at + 3_600_000, at);
    }

    const before = mailed.length;
    const unknownAddress = await gpost("/v1/register", {
      name: "nina",
      password: "correct horse battery",
      email: "nina@example.com",
    });
    const takenAddress = await gpost("/v1/register", {
      name: "oscar",
      password: "correct horse battery",
      email: "paula@example.com",
    });
    check(
      "a fresh address and a taken one answer identically with the queue full",
      [unknownAddress.status, takenAddress.status],
      [200, 200],
    );
    check("and nothing was queued, so the queue really was full", mailed.length - before, 0);
  }

  /* -- a mailer that never settles --------------------------------------- */

  {
    /*
     * The one property about mail this driver can reach, and the reason `mail`
     * is an injected interface rather than the pump: a mailer that never
     * resolves must not change a route's status or hold its response.
     */
    const stuck = createControlPlaneApp({
      db: gdb,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl: "ws://relay.invalid",
      mail: {
        enqueue: () => "mo_stuck",
        wake: () => {
          // Never settles. If any route awaited this, the request would hang.
          void new Promise(() => undefined);
        },
      },
    });
    const started = Date.now();
    const answer = await stuck.request("/v1/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "carol@example.com" }),
    });
    report(
      "a mailer that never settles neither fails a request nor delays it",
      answer.status === 200 && Date.now() - started < 1000,
      `${answer.status} in ${Date.now() - started}ms`,
    );
  }

  gdb.close();
}

/* ------------------------------------------------------------------ *
 * The fleet inventory, read back
 *
 * The write half is asserted up in "tunnel identity" — a real dial, through a
 * real socket, landing in `machines.daemon_*`. The **read** half was asserted by
 * nothing at all: the route, its `requireAdmin`, and the `byProtocol` summary
 * were reachable only through `cpctl`.
 *
 * That matters more than an unread route usually would, because rule 4 of
 * `.claude/rules/compatibility.md` makes this the thing a floor-raise is decided
 * from — "watch `cpctl admin fleet` until nothing is below the new version" — so
 * a wrong answer here is not a wrong screen, it is a machine stranded on purpose.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe fleet inventory, as the route answers it\n");
{
  const fdb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(fdb);
  ensureSigningKey(fdb);
  const at = Date.now();

  const fleetApp = createControlPlaneApp({
    db: fdb,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
  });

  const key = newApiKey();
  fdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_fa', 'fleetadmin', 1, ?)").run(at);
  fdb.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_fa', ?, ?, ?)").run(
    newId("ak"), key.prefix, key.hash, at,
  );
  const plain = newApiKey();
  fdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_fp', 'fleetplain', 0, ?)").run(at);
  fdb.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_fp', ?, ?, ?)").run(
    newId("ak"), plain.prefix, plain.hash, at,
  );

  /*
   * Four machines, chosen so every arm of the summary is populated by one of
   * them: one that reported, one that never has, one that is revoked, and one
   * behind the relay's own version.
   */
  const machine = (id: string, name: string, revoked: boolean): void => {
    fdb.prepare("INSERT INTO machines (id, name, created_at, revoked_at) VALUES (?, ?, ?, ?)")
      .run(id, name, at, revoked ? at : null);
  };
  machine("m_cur", "current", false);
  machine("m_quiet", "quiet", false);
  machine("m_gone", "gone", true);
  recordDaemonBuild(fdb, "m_cur", {
    daemonVersion: "1.2.3",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    agentClis: "claude=2.1.259;codex=0.153.1;kimi=-",
    at,
  });
  recordDaemonBuild(fdb, "m_gone", { daemonVersion: "0.0.1", protocolVersion: RELAY_PROTOCOL_VERSION, agentClis: null, at });

  const fleet = async (bearer: string | null): Promise<Response> =>
    Promise.resolve(
      fleetApp.request("/v1/admin/fleet", bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    );

  check("the fleet route refuses a caller with no credential", (await fleet(null)).status, 401);
  check("and refuses one who is not an admin", (await fleet(plain.key)).status, 403);

  const answer = await fleet(key.key);
  check("and answers an admin", answer.status, 200);
  const body = (await answer.json()) as {
    relay: { protocol: number; oldestAccepted: number };
    byProtocol: Record<string, number>;
    machines: {
      id: string;
      name: string;
      revoked: boolean;
      version: string | null;
      protocol: number | null;
      agents: Record<string, string | null> | null;
    }[];
  };

  check(
    "it names the range this relay speaks, which is what a floor-raise is read against",
    [body.relay.oldestAccepted, body.relay.protocol],
    [RELAY_PROTOCOL_MIN_VERSION, RELAY_PROTOCOL_VERSION],
  );

  const byId = new Map(body.machines.map((m) => [m.id, m]));
  check("a machine that dialled reports the build it sent", byId.get("m_cur")?.version, "1.2.3");
  check("and the protocol it agreed", byId.get("m_cur")?.protocol, RELAY_PROTOCOL_VERSION);
  /*
   * And which CLI builds it would launch, read back as harness → version rather
   * than as the wire string, so `cpctl` and any later screen do not each carry
   * the grammar. `null` for a binary that would not say, which is what `-` means.
   */
  check(
    "and the CLI builds it would launch, as of the same dial",
    byId.get("m_cur")?.agents,
    { claude: "2.1.259", codex: "0.153.1", kimi: null },
  );
  check("a machine that said nothing about its CLIs answers null, not an empty list", byId.get("m_gone")?.agents, null);
  /*
   * The one that has never dialled is the whole point of the route: it is listed,
   * with nulls, rather than omitted the way a report of what is *connected* would
   * omit it. That machine is the one that decides whether the floor can move.
   */
  check("a machine that has never dialled is listed rather than omitted", byId.has("m_quiet"), true);
  check(
    "and says nothing rather than guessing",
    [byId.get("m_quiet")?.version, byId.get("m_quiet")?.protocol, byId.get("m_quiet")?.agents],
    [null, null, null],
  );

  /* A revoked machine still appears — it is inventory — but cannot hold the floor down. */
  check("a revoked machine is still listed", byId.get("m_gone")?.revoked, true);
  check(
    "but is not counted in the summary a floor-raise is decided from",
    body.byProtocol,
    { [String(RELAY_PROTOCOL_VERSION)]: 1, unknown: 1 },
  );

  fdb.close();
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
