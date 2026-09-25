#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { connect as h2connect, createServer as createH2Server, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { Duplex, PassThrough } from "node:stream";
import { connect as netConnect, createServer as netCreateServer, type AddressInfo, type Socket } from "node:net";
import { TLSSocket, createServer as tlsCreateServer } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { jwkThumbprint, parseClaims, publicKeyToJwk, signToken, x25519Jwk, type TokenClaims } from "../src/token.js";
import { describeError } from "../src/http.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { peerEndToEnd } from "./relaycheck.peer-e2e.js";
import { SignedTokenVerifier } from "../src/auth.js";
import {
  FRAME,
  LengthReader,
  NoiseHandshake,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  generateStaticKey,
  localStaticKey,
  type CipherState,
} from "@reemoat/protocol";
import { KEY_REFRESH_MS, createRelayAuthorizer } from "../packages/control-plane/src/relay/authorize.js";
import {
  CLOSE_TUNNEL_SUPERSEDED,
  CONNECTION_WINDOW_BYTES,
  MAX_STREAMS_PER_SUBJECT,
  MAX_STREAMS_PER_LINK,
  MAX_LINK_STREAMS_PER_TUNNEL,
  LINK_CONNECT_BURST,
  LINK_CONNECT_REFILL_MS,
  RELAY_URL_HEADER,
  MAX_TUNNEL_BUFFERED_BYTES,
  MAX_TUNNEL_MESSAGE_BYTES,
  RECONNECT_MAX_MS,
  AGENT_CLIS_HEADER,
  DAEMON_VERSION_HEADER,
  MAX_AGENT_CLIS_CHARS,
  MAX_DAEMON_VERSION_CHARS,
  MACHINE_KEY_HEADER,
  MAX_MACHINE_KEY_CHARS,
  formatAgentClis,
  parseAgentClis,
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  RELAY_PROTOCOL_MIN_VERSION,
  RELAY_PROTOCOL_VERSION,
  TUNNEL_AGREED_VERSION_HEADER,
  negotiateProtocolVersion,
  STREAM_ENCRYPTION_HEADER,
  STREAM_ENCRYPTION_NOISE_IK,
  STREAM_SUBJECT_HEADER,
  STREAM_VERSION_HEADER,
  STREAM_WINDOW_BYTES,
  TUNNEL_PATH,
  TUNNEL_VERSION_HEADER,
  reconnectDelayMs,
} from "../src/relay/protocol.js";
import { machineKeyFor, setMachineKey } from "../packages/control-plane/src/machinekeys.js";
import { RELAY_CHANNEL_PATH, RELAY_HEALTH_PATH, createRelayListener } from "../packages/control-plane/src/relay/listener.js";
import {
  DEFAULT_RELAY_ID,
  PRESENCE_STALE_MS,
  RELAY_CLAIM_STALE_MS,
  claimRelayId,
  createPresenceWriter,
  dbRelayView,
  releaseRelayId,
} from "../packages/control-plane/src/relay/presence.js";
import { RelayTunnel as EndpointTunnel, TunnelRegistry, type StreamLimiter } from "../packages/control-plane/src/relay/registry.js";
import { LinkConnectBudget } from "../packages/control-plane/src/relay/proxy.js";
import {
  activePublicKeys,
  ensureSigningKey,
  issueTunnelKey,
  keyIdFor,
  mintSigningKey,
  newApiKey,
  newId,
  pruneEnrollmentCodes,
  retireSigningKey,
} from "../packages/control-plane/src/keys.js";
import { KEY_TOUCH_INTERVAL_MS, LINK_TOKEN_TTL_SECONDS, createControlPlaneApp } from "../packages/control-plane/src/app.js";
import { applyControlPlaneSchema } from "../packages/control-plane/src/store.js";
import {
  DEVICE_PUBLIC_KEY_CHARS,
  DEVICE_REVOKED_RETENTION_MS,
  MAX_DEVICE_NAME_CHARS,
  MAX_DEVICE_PLATFORM_CHARS,
  MAX_DEVICES_PER_USER,
  adoptDevice,
  deviceKeyFor,
  pruneDevices,
  revokeDevice,
} from "../packages/control-plane/src/devices.js";
import { readAgentClisHeader, readDaemonVersionHeader, recordDaemonBuild } from "../packages/control-plane/src/machines.js";
import { MAX_ADDRESS_CHARS, callerAddressOf, forwardingIgnored } from "../packages/control-plane/src/net.js";
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
  revokeSession,
  touchSession,
} from "../packages/control-plane/src/sessions.js";
import {
  ADDRESS_THROTTLE,
  DEFAULT_THROTTLE,
  LoginThrottle,
  MAX_KEY_CHARS,
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

/** Regression driver for the relay: one process on loopback, no fleet. Flow control guards against a window replenished on arrival rather than on read. */

// Clear every setting from the environment first: `readSetting` falls through to it, so an operator's exports would decide the fixtures.
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

// Declared before `tokenFor`, which binds every capability to it.
const driverDevice = generateStaticKey();
const driverThumbprint = jwkThumbprint(x25519Jwk(driverDevice.publicKey));
const mineStatic = generateStaticKey();

/** A capability bound to this driver's device by `cnf`; the daemon refuses one with no binding (`unbound_capability`). */
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
    cnf: { jkt: driverThumbprint },
  };
  return signToken(claims, signing.kid, signing.privateKey);
}

// An in-memory daemon of the real one's shape: `/flood` drives flow control and `/stream` stands in for `/sessions/:id/stream`.

let floodWritten = 0;
const daemon = createServer((req, res) => {
  const target = req.url ?? "/";
  // Answers, sends part of its `content-length`, then goes silent: the shape only the relay's idle bound can end.
  if (target.startsWith("/halfbody")) {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(1024 * 1024) });
    res.write(Buffer.alloc(64 * 1024, 97));
    return;
  }
  if (target.startsWith("/flood")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(16 * 1024, 7);
    // Endless by default, bounded by `?bytes=`; the bounded form keeps its own counter because the stalled case asserts on `floodWritten`.
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

// Sends `hello` unprompted on open, as `StreamConnection` does, then echoes: both directions of a tunnelled upgrade.
const daemonWss = new WebSocketServer({ noServer: true });
daemon.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://daemon").pathname;
  if (path !== "/stream") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  daemonWss.handleUpgrade(req, socket, head, (ws) => {
    // The relayed request carries the caller's real token; echoed so the case can assert it arrived.
    const url = new URL(req.url ?? "/", "http://daemon");
    ws.send(JSON.stringify({ type: "hello", token: url.searchParams.get("token") === null ? null : "present" }));
    ws.on("message", (data: Buffer) => ws.send(JSON.stringify({ type: "echo", text: data.toString() })));
  });
});

// The shipped listener, not a copy; `presence` is left out so no flush timer races the stats assertions.
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

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", () => resolve()));
}

// Look tunnels up by machine, never by position: stats is insertion-ordered and earlier sections leave `m_other` tunnels behind.
function proxied(machineId: string): number {
  return registry.stats().find((tunnel) => tunnel.machineId === machineId)?.requestsProxied ?? -1;
}

function activeStreams(machineId: string): number {
  return registry.stats().find((tunnel) => tunnel.machineId === machineId)?.activeStreams ?? -1;
}

// A driver reaching a daemon must be an app: a Noise_IK initiator with a device key and a bound capability.
// A refusal still arrives as the upgrade's HTTP status.

async function relayFetch(
  path: string,
  token: string | null,
  options: { secretKey?: Uint8Array; remoteStatic?: Uint8Array; body?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve) => {
    const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}${query}`);
    const reader = new LengthReader();
    const handshake = NoiseHandshake.start({
      initiator: true,
      staticKey: localStaticKey(options.secretKey ?? driverDevice.secretKey),
      remoteStatic: options.remoteStatic ?? mineStatic.publicKey,
    });
    let send: CipherState | null = null;
    let receive: CipherState | null = null;
    let head: { status: number } | null = null;
    const chunks: Buffer[] = [];
    let settled = false;

    const give = (status: number, body: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      resolve({ status, body });
    };
    const timer = setTimeout(() => give(0, "(no answer)"), 10_000);
    timer.unref();

    const write = (frame: Uint8Array): void => {
      ws.send(frameLength(send!.encrypt(new Uint8Array(0), frame)));
    };

    ws.on("open", () => {
      void handshake.writeMessage().then((first: Uint8Array) => ws.send(frameLength(first)));
    });
    ws.on("message", (data: Buffer) => {
      for (const message of reader.push(new Uint8Array(data))) {
        if (send === null) {
          void handshake
            .readMessage(message)
            .then(() => {
              const transport = handshake.split();
              send = transport.send;
              receive = transport.receive;
              write(encodeJsonFrame(FRAME.HELLO, { capability: token ?? "" }));
            })
            .catch(() => give(0, "(handshake failed)"));
          continue;
        }
        let frame: { type: number; payload: Uint8Array } | null;
        try {
          frame = decodeFrame(receive!.decrypt(new Uint8Array(0), message));
        } catch {
          give(0, "(bad ciphertext)");
          return;
        }
        if (frame === null) continue;
        if (frame.type === FRAME.READY) {
          write(
            encodeJsonFrame(FRAME.REQUEST, {
              method: options.method ?? "GET",
              path,
              headers: options.body === undefined ? {} : { "content-type": "application/json" },
              body: options.body !== undefined,
            }),
          );
          if (options.body !== undefined) {
            write(encodeFrame(FRAME.REQUEST_BODY, new TextEncoder().encode(options.body)));
            write(encodeFrame(FRAME.REQUEST_END));
          }
        } else if (frame.type === FRAME.RESPONSE) {
          head = JSON.parse(new TextDecoder().decode(frame.payload)) as { status: number };
        } else if (frame.type === FRAME.RESPONSE_BODY) {
          chunks.push(Buffer.from(frame.payload));
        } else if (frame.type === FRAME.RESPONSE_END) {
          give(head?.status ?? 0, Buffer.concat(chunks).toString("utf8"));
        } else if (frame.type === FRAME.FAILED) {
          const close = JSON.parse(new TextDecoder().decode(frame.payload)) as { code: number; reason: string };
          give(close.code, close.reason);
        }
      }
    });
    // `refuseUpgrade` puts the refusal's code on the status line, so `statusMessage` is surfaced as the body.
    ws.on("unexpected-response", (_req, res) => give(res.statusCode ?? 0, res.statusMessage ?? ""));
    ws.on("error", () => give(0, "(no channel)"));
  });
}

// Opens a flood and stops reading so the h2 window behind it closes: `ws.pause` stalls the TCP socket itself.
async function channelFlood(path: string, token: string): Promise<{ destroy: () => void }> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(token)}`);
    const reader = new LengthReader();
    const handshake = NoiseHandshake.start({
      initiator: true,
      staticKey: localStaticKey(driverDevice.secretKey),
      remoteStatic: mineStatic.publicKey,
    });
    let cipher: CipherState | null = null;
    let receive: CipherState | null = null;
    let settled = false;
    const give = (): void => {
      if (settled) return;
      settled = true;
      resolve({ destroy: () => ws.terminate() });
    };
    setTimeout(give, 5_000).unref();

    ws.on("open", () => {
      void handshake.writeMessage().then((first: Uint8Array) => ws.send(frameLength(first)));
    });
    ws.on("message", (data: Buffer) => {
      for (const message of reader.push(new Uint8Array(data))) {
        if (cipher === null) {
          void handshake
            .readMessage(message)
            .then(() => {
              const transport = handshake.split();
              cipher = transport.send;
              receive = transport.receive;
              ws.send(frameLength(cipher.encrypt(new Uint8Array(0), encodeJsonFrame(FRAME.HELLO, { capability: token }))));
            })
            .catch(give);
          continue;
        }
        let frame: { type: number; payload: Uint8Array } | null;
        try {
          frame = decodeFrame(receive!.decrypt(new Uint8Array(0), message));
        } catch {
          give();
          return;
        }
        if (frame?.type !== FRAME.READY) continue;
        ws.send(
          frameLength(
            cipher.encrypt(
              new Uint8Array(0),
              encodeJsonFrame(FRAME.REQUEST, { method: "GET", path, headers: {}, body: false }),
            ),
          ),
        );
        ws.pause();
        give();
      }
    });
    ws.on("unexpected-response", give);
    ws.on("error", give);
  });
}

// Sends through `encodeMessageFrames` and reassembles bytes until `MESSAGE_END`, decoding once: a chunk can split a UTF-8 sequence.
async function channelSocket(path: string, token: string, send: string): Promise<string[]> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(token)}`);
    const reader = new LengthReader();
    const handshake = NoiseHandshake.start({
      initiator: true,
      staticKey: localStaticKey(driverDevice.secretKey),
      remoteStatic: mineStatic.publicKey,
    });
    let cipher: CipherState | null = null;
    let receive: CipherState | null = null;
    const seen: string[] = [];
    /** The chunks of the message currently arriving, held until `MESSAGE_END`. */
    let assembling: Uint8Array[] = [];
    let settled = false;
    const give = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      ws.terminate();
      resolve(seen);
    };
    const bail = setTimeout(give, 5_000);
    bail.unref();

    const write = (frame: Uint8Array): void => {
      ws.send(frameLength(cipher!.encrypt(new Uint8Array(0), frame)));
    };

    ws.on("open", () => {
      void handshake.writeMessage().then((first: Uint8Array) => ws.send(frameLength(first)));
    });
    ws.on("message", (data: Buffer) => {
      for (const message of reader.push(new Uint8Array(data))) {
        if (cipher === null) {
          void handshake
            .readMessage(message)
            .then(() => {
              const transport = handshake.split();
              cipher = transport.send;
              receive = transport.receive;
              write(encodeJsonFrame(FRAME.HELLO, { capability: token }));
            })
            .catch(give);
          continue;
        }
        let frame: { type: number; payload: Uint8Array } | null;
        try {
          frame = decodeFrame(receive!.decrypt(new Uint8Array(0), message));
        } catch {
          give();
          return;
        }
        if (frame === null) continue;
        if (frame.type === FRAME.READY) write(encodeJsonFrame(FRAME.OPEN, { path }));
        else if (frame.type === FRAME.OPENED) {
          for (const one of encodeMessageFrames(new TextEncoder().encode(send))) write(one);
        } else if (frame.type === FRAME.MESSAGE) assembling.push(frame.payload);
        else if (frame.type === FRAME.MESSAGE_END) {
          const whole = new Uint8Array(assembling.reduce((total, part) => total + part.length, 0));
          let at = 0;
          for (const part of assembling) {
            whole.set(part, at);
            at += part.length;
          }
          assembling = [];
          seen.push(new TextDecoder().decode(whole));
          if (seen.length === 2) give();
        } else if (frame.type === FRAME.FAILED) give();
      }
    });
    ws.on("unexpected-response", give);
    ws.on("error", give);
  });
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

process.stdout.write("\nreconnect backoff\n");
{
  // Full jitter lies in [0, window]; a fixed random makes the bounds exact.
  const maxes = [1, 2, 3, 4, 5, 6, 10, 20].map((attempt) => reconnectDelayMs(attempt, () => 1));
  const mins = [1, 5, 20].map((attempt) => reconnectDelayMs(attempt, () => 0));
  check("full jitter can return zero", mins, [0, 0, 0]);
  check("the window doubles then caps", maxes, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  check("the cap is the documented one", maxes[maxes.length - 1], RECONNECT_MAX_MS);
  const spread = new Set(Array.from({ length: 200 }, () => reconnectDelayMs(6)));
  report("jitter actually spreads", spread.size > 100, `${spread.size} distinct delays in 200 draws`);
}

process.stdout.write("\ntunnel identity\n");

/** `version: null` omits the header entirely, which is what a pre-header daemon does. */
async function tryTunnel(
  key: string | null,
  version: string | null,
  machineKey: string | null = null,
): Promise<number | "connected"> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (version !== null) headers[TUNNEL_VERSION_HEADER] = version;
    if (key !== null) headers["authorization"] = `Bearer ${key}`;
    if (machineKey !== null) headers[MACHINE_KEY_HEADER] = machineKey;
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

// Versions are negotiated, not compared: newer is negotiated down, older is accepted until the floor rises past it.
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
// A missing header reads as `PRE_NEGOTIATION_PROTOCOL_VERSION`, below the floor, so it is refused with 426.
check("a daemon that predates the header is refused, not let in", await tryTunnel(myTunnelKey, null), 426);
// A refused dial is told nothing; `PRE_NEGOTIATION_PROTOCOL_VERSION` is pinned to the literal 1, never to the floor.
check("and is told nothing, because the dial never completed", await agreedVersion(myTunnelKey, null), null);
check(
  "which is what PRE_NEGOTIATION_PROTOCOL_VERSION is, and it is not the floor by definition",
  PRE_NEGOTIATION_PROTOCOL_VERSION,
  1,
);

// Through the socket: the build header must survive the dial and be recorded against the credential's machine.
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

  await tryTunnel(myTunnelKey, String(RELAY_PROTOCOL_VERSION));
  check("a daemon that reports no build still connects, and records none", fleetRow()["daemon_version"], null);

  await withVersion(`${"v".repeat(200)}`);
  check(
    "an over-long build string is cut rather than stored whole",
    String(fleetRow()["daemon_version"] ?? "").length,
    MAX_DAEMON_VERSION_CHARS,
  );
  // Asserted on the function: Node's HTTP client refuses to send a control character in a header (`ERR_INVALID_CHAR`).
  check(
    "a build string is scrubbed of control characters before it is stored",
    readDaemonVersionHeader("1.0\u0000\u001b[31m-injected"),
    "1.0[31m-injected",
  );
  check("and an empty one reads as no answer rather than as a version", readDaemonVersionHeader("   "), null);
  check("and a header nobody sent reads the same way", readDaemonVersionHeader(undefined), null);
  check("and an array-valued header takes its first entry", readDaemonVersionHeader(["1.2.3", "9"]), "1.2.3");

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

  check("a daemon that announces no inventory still connects", await withClis(null), "connected");
  check("and is listed with none, replacing what an earlier dial said", agentsRow(), null);
  check("while its build is still recorded", fleetRow()["daemon_version"], "9.9.9-clis");

  await withClis("claude=2.1.300");
  check("a malformed inventory does not cost the dial", await withClis("claude=2.1;;codex"), "connected");
  check("and is refused whole rather than stored in part", agentsRow(), null);
  await withClis("claude=2.1.300");
  check("an over-long inventory does not cost the dial", await withClis(`claude=${"9".repeat(MAX_AGENT_CLIS_CHARS)}`), "connected");
  check("and is refused whole rather than cut — a cut list is a false version", agentsRow(), null);
  await withClis("claude=2.1.300");
  check("a duplicated harness does not cost the dial", await withClis("claude=1.0.0;claude=2.0.0"), "connected");
  check("and is refused, since two answers for one harness is no answer", agentsRow(), null);

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

  const untilOffline = async (): Promise<void> => {
    const gone = Date.now() + 5_000;
    while (Date.now() < gone && registry.isOnline(mine)) await sleep(25);
  };
  const dialWith = async (options: { agentClis: () => Promise<Record<string, string | null>>; announceTimeoutMs?: number }): Promise<boolean> => {
    // Wait until offline first: the raw dials above unregister a tick late, so the row read could be theirs.
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

check("negotiation takes the newest both ends know", negotiateProtocolVersion(99), RELAY_PROTOCOL_VERSION);
check("and refuses what is below the floor", negotiateProtocolVersion(RELAY_PROTOCOL_MIN_VERSION - 1), null);
check("and refuses a fraction, which is not a version", negotiateProtocolVersion(1.5), null);
check("and refuses NaN, which is what a non-numeric header parses to", negotiateProtocolVersion(Number("x")), null);

// No field in the tunnel handshake names a machine: the credential alone decides whose tunnel it is.
{
  const revoked = issueTunnelKey(db, other); // rotating `other` retires the previous key
  check("re-issuing retires the previous credential", await tryTunnel(otherTunnelKey, String(RELAY_PROTOCOL_VERSION)), 401);
  check("the newly issued credential works", await tryTunnel(revoked, String(RELAY_PROTOCOL_VERSION)), "connected");
}

// The dial-side refusal in `tunnel-endpoint.ts`: a suspended machine must read offline and over limit, not online and broken.
// 403, not 401, so the daemon does not re-enroll and rotate a good key.
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

  writeMachineLimit(db, alice, 5, "u_admin");
  check("raising the limit lets the same key dial again", await tryTunnel(myTunnelKey, version), "connected");

  // One refusal for both gates: a daemon has nothing to do differently about them.
  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(Date.now(), alice);
  check("a banned owner's daemon is refused at dial too", await tryTunnel(myTunnelKey, version), 403);
  db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(alice);

  clearMachineLimit(db, alice);
  db.prepare("DELETE FROM machine_owners WHERE machine_id = ?").run(mine);
  check("and it dials once more with all of that undone", await tryTunnel(myTunnelKey, version), "connected");
}

// Machine keys are trust on first use: the first announced key is pinned and a later disagreement is refused.

process.stdout.write("\nmachine identity, pinned on the dial\n");
{
  const version = String(RELAY_PROTOCOL_VERSION);
  const keyOf = (machineId: string): string | null => machineKeyFor(db, machineId);
  const first = "A".repeat(MAX_MACHINE_KEY_CHARS);
  const second = "B".repeat(MAX_MACHINE_KEY_CHARS);

  // Its own machine and credential: `m_other`'s tunnel key was retired by an earlier section.
  const keyed = addMachine("m_keyed");
  const keyedTunnelKey = issueTunnelKey(db, keyed);

  check("a daemon that announces no key still dials", await tryTunnel(keyedTunnelKey, version), "connected");
  check("and nothing was pinned for it", keyOf(keyed), null);

  check("the first announcement dials", await tryTunnel(keyedTunnelKey, version, first), "connected");
  check("and it is what got pinned", keyOf(keyed), first);

  check("the same key again dials", await tryTunnel(keyedTunnelKey, version, first), "connected");
  check("and the pin did not move", keyOf(keyed), first);

  // 409, not 403: the credential is right, but two statements about one machine conflict.
  check("a different key is refused at the dial", await tryTunnel(keyedTunnelKey, version, second), 409);
  check("and the refusal changed nothing", keyOf(keyed), first);

  // The refusal is a read, so a stolen tunnel key cannot use it to take the machine offline.
  check("and the real daemon still dials afterwards", await tryTunnel(keyedTunnelKey, version, first), "connected");

  check("a key of the wrong length is ignored, not refused", await tryTunnel(keyedTunnelKey, version, "short"), "connected");
  check(
    "and one with bytes outside the alphabet too",
    await tryTunnel(keyedTunnelKey, version, "!".repeat(MAX_MACHINE_KEY_CHARS)),
    "connected",
  );
  check("neither of which moved the pin", keyOf(keyed), first);

  // Enrollment, which never passes through the relay, is the only door that replaces a pin.
  setMachineKey(db, keyed, second);
  check("redeeming a code records a key whatever was there", keyOf(keyed), second);
  check("and the daemon holding the new key dials", await tryTunnel(keyedTunnelKey, version, second), "connected");

  db.prepare("UPDATE machines SET machine_key = NULL, machine_key_set_at = NULL WHERE id = ?").run(keyed);
  check("and a pin can be given up again", keyOf(keyed), null);
}

// Required: with no `staticKey` or `verifier` a tunnel answers 501 on every stream, since Noise_IK is the only mode.
const mineVerifier = new SignedTokenVerifier({
  identity: {
    machineId: mine,
    issuer: ISSUER,
    keys: [{ kid: signing.kid, jwk: signing.jwk }],
  },
});

const tunnel = RelayTunnel.start({
  relayUrl,
  tunnelKey: myTunnelKey,
  local: { host: "127.0.0.1", port: daemonPort },
  agentClis: async () => ({ claude: "2.1.259", codex: null }),
  staticKey: localStaticKey(mineStatic.secretKey),
  verifier: mineVerifier,
});

process.stdout.write("\nthe tunnel\n");
check("the tunnel comes up", await waitForTunnel(mine), true);
// Polled: `waitForTunnel` may answer for the previous section's raw dial, still being unregistered.
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
  // The route is the `aud` claim, so this token cannot reach `m_mine` whatever else holds.
  check("a token minted for another machine", (await relayFetch("/x", tokenFor(alice, other))).status, 404);

  const after = proxied(mine);
  report("none of them touched the tunnel", before === after, `requestsProxied stayed at ${before}`);
}

// A target llhttp accepts and the URL parser refuses must be answered, not held, or each such line leaks an fd.

process.stdout.write("\nan unparseable request target\n");
{
  const before = proxied(mine);

  // Raw socket: `fetch` and `ws` both normalize the target through the parser under test.
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
  // `pathOf` maps an unparseable target to the root, which the retired plaintext handler refuses with 426 before reading anything.
  check("and the relay answers rather than holding the socket", refused.split("\r\n")[0], "HTTP/1.1 426 Upgrade Required");
  check("with the sentence saying a plaintext request is not carried", refused.includes("encrypted channels only"), true);
  check(
    "the other two shapes are answered the same way",
    [await rawResponse("/\\", ["connection: close"]), await rawResponse("//[", ["connection: close"])].map(
      (answer) => answer.split(" ")[1] ?? "(none)",
    ),
    ["426", "426"],
  );

  // The upgrade path, where `?token=` is read: `refuseUpgrade` writes a status line and destroys the socket.
  const upgrade = await rawResponse("//%", [
    "upgrade: websocket",
    "connection: Upgrade",
    "sec-websocket-version: 13",
    `sec-websocket-key: ${randomBytes(16).toString("base64")}`,
  ]);
  check("an upgrade with the same target is refused too", upgrade.split("\r\n")[0], "HTTP/1.1 426 upgrade_required");

  report("none of them touched the tunnel", proxied(mine) === before, `requestsProxied stayed at ${before}`);
}

process.stdout.write("\nkey rotation\n");
{
  // A rotation must be picked up even right after a nonsense `kid` warmed the key-cache throttle: both are cache misses.
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
      cnf: { jkt: driverThumbprint },
    },
    rotatedKid,
    rotated.privateKey,
  );

  // Warm the throttle with an unknown kid first, exactly as a flood would.
  check("an unknown key is refused", (await relayFetch("/x", tokenFor(alice, mine).replace(/^[^.]+/, "eyJhbGciOiJFZERTQSIsInR5cCI6InJlbW9zbG9wK2p3dCIsImtpZCI6Il9ub25lXyJ9"))).status, 401);
  await sleep(1_100);
  // The relay accepts it because its cache refreshed on the miss; the daemon refuses it because its key set predates the rotation.
  // The stream counter is the discriminator, not the code: relay and daemon both answer `unknown_key`.
  const beforeRotated = proxied(mine);
  const rotatedAnswer = await relayFetch("/sessions", freshlySigned);
  report(
    "a token signed by a newly added key gets past the relay, so the cache refreshed",
    proxied(mine) - beforeRotated === 1,
    `${proxied(mine) - beforeRotated} streams, answered ${rotatedAnswer.status} ${rotatedAnswer.body}`,
  );
  check(
    "and the daemon refuses it, because its own key set predates the rotation",
    [rotatedAnswer.status, rotatedAnswer.body],
    [401, "unknown_key"],
  );
}

process.stdout.write("\nwhat reaches the daemon\n");
{
  const ok = await relayFetch("/sessions?x=1", tokenFor(alice, mine));
  check("an authorized request reaches the daemon", ok.status, 200);
  check("the path arrives intact", JSON.parse(ok.body).path, "/sessions?x=1");

  // The relay writes no request headers, so the daemon sees the relay's header namespace empty (Q5.10).
  check("relay metadata stays on the tunnel, out of the request", JSON.parse(ok.body).subject, null);
}

// A socket is a frame inside a channel (`OPEN`, `OPENED`, `MESSAGE`, `CLOSE`); the daemon's loopback dial carries the credential in a header (Q6.37).
process.stdout.write("\na websocket through a channel\n");
{
  const before = proxied(mine);

  const refused = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}`);
    ws.on("open", () => {
      ws.close();
      resolve("opened");
    });
    ws.on("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    ws.on("error", (error: Error) => resolve(`error ${error.message}`));
  });
  check("an unauthorized channel is refused", refused, "http 401");

  const unauthorized = proxied(mine);
  report("and never reached the tunnel", before === unauthorized, `requestsProxied stayed at ${before}`);

  const frames = await channelSocket("/stream", tokenFor(alice, mine), "ping through the tunnel");

  check("the daemon's first frame arrives through the channel", JSON.parse(frames[0] ?? "null"), {
    type: "hello",
    // `null`: over a channel the daemon's dial carries the capability in an `authorization` header, not `?token=`.
    token: null,
  });
  check("and a frame sent by the client comes back", JSON.parse(frames[1] ?? "null"), {
    type: "echo",
    text: "ping through the tunnel",
  });

  const after = proxied(mine);
  report("the authorized channel took exactly one stream", after - unauthorized === 1, `${after - unauthorized}`);

  // A channel holds its h2 stream for the socket's life, so a leak would show as this request never being answered.
  await sleep(50);
  check("the tunnel still serves ordinary requests", (await relayFetch("/sessions", tokenFor(alice, mine))).status, 200);
  // Polled: the request above opens and closes a channel of its own, so one read races its teardown.
  const settled = Date.now() + 2_000;
  while (Date.now() < settled && activeStreams(mine) !== 0) await sleep(25);
  report(
    "and the channel's stream was released",
    activeStreams(mine) === 0,
    `activeStreams ${activeStreams(mine)}`,
  );
}

process.stdout.write("\nflow control\n");
{
  floodWritten = 0;

  // A client asks for an endless response and never reads it; with credit granted on consumption the daemon stops after about one window.
  // `ws.pause` stalls the TCP socket itself, so every link of the chain is the real one.
  const stalled = await channelFlood("/flood", tokenFor(alice, mine));

  await sleep(1_200);
  const parked = floodWritten;

  // Generous on purpose, one term per buffer in the chain: the assertion is bounded, not a specific number.
  const bound = MAX_TUNNEL_BUFFERED_BYTES * 2 + STREAM_WINDOW_BYTES + 8 * 1024 * 1024;

  // Guards a vacuous pass: a flood that never started would park at zero and pass the bound.
  report("the flood actually ran", parked > STREAM_WINDOW_BYTES, `${parked} bytes written before parking`);

  report(
    "a stalled consumer stops the sender",
    parked < bound,
    `${(parked / 1024 / 1024).toFixed(1)} MiB written, bound ${(bound / 1024 / 1024).toFixed(0)} MiB`,
  );

  await sleep(800);
  // Bounded by one window rather than zero: the channel socket's buffer drains once more before the sender parks again.
  const grew = floodWritten - parked;
  report(
    "and it stays stopped, bar the one window the extra hop was holding",
    grew < STREAM_WINDOW_BYTES,
    grew === 0 ? "no further growth" : `grew by ${grew} bytes, under one ${STREAM_WINDOW_BYTES}-byte window`,
  );

  const started = Date.now();
  const healthy = await relayFetch("/sessions", tokenFor(alice, mine));
  const elapsed = Date.now() - started;
  check("a second client still works while the first is stalled", healthy.status, 200);
  report("and is not slowed by it", elapsed < 1_000, `${elapsed}ms`);

  // Retiring a key must take effect in a running relay within `KEY_REFRESH_MS`: after a rotation the old `kid` is a cache hit.
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
    // `ws` assembles whole messages before h2 sees a byte, so `maxPayload` is the only inbound bound.
    // It must not sit below one coalesced write, or it closes healthy tunnels.
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

process.stdout.write("\na client that reads\n");
{
  // The brake's mirror: a reading client must get a body several windows long (Q6.36).
  // A regression guard; it does not reproduce the stall in Q6.104.
  const want = 4 * STREAM_WINDOW_BYTES;
  const started = Date.now();
  const flood = await relayFetch(`/flood?bytes=${want}`, tokenFor(alice, mine));
  const got = Buffer.byteLength(flood.body);
  const elapsed = Date.now() - started;

  check("a reading client gets a body several windows long", got, want);
  report("and does not sit waiting on credit", got === want && elapsed < 5_000, `${want} bytes in ${elapsed}ms`);
}

process.stdout.write("\nan upstream that dies mid-body\n");
{
  // A daemon that dies mid-body must reach the client as `FAILED`, never `RESPONSE_END`: whole is a byte on the wire (Q6.103).
  // `/halfbody` writes 64 KiB of a promised megabyte then goes silent; `upstreamTimeoutMs` bounds it.
  const half = addMachine("m_halfbody");
  grant(alice, half);
  const halfStatic = generateStaticKey();
  const halfTunnel = RelayTunnel.start({
    relayUrl,
    tunnelKey: issueTunnelKey(db, half),
    local: { host: "127.0.0.1", port: daemonPort },
    staticKey: localStaticKey(halfStatic.secretKey),
    verifier: new SignedTokenVerifier({
      identity: { machineId: half, issuer: ISSUER, keys: [{ kid: signing.kid, jwk: signing.jwk }] },
    }),
    upstreamTimeoutMs: 300,
  });
  check("the half-answering daemon's tunnel is up", await waitForTunnel(half), true);

  const started = Date.now();
  const ended = await relayFetch("/halfbody", tokenFor(alice, half), { remoteStatic: halfStatic.publicKey });
  const waited = Date.now() - started;

  report(
    "a daemon that dies mid-body does not hand back a short answer",
    ended.status === 502,
    `status ${ended.status} after ${waited}ms`,
  );
  // Either code is a `FAILED` frame; which one depends on whether `error` or `close` fires first.
  report(
    "and it is named as a failure rather than delivered as an answer",
    ended.body === "tunnel_failed" || ended.body === "truncated",
    ended.body,
  );
  report("with the bound ending it rather than the client giving up", waited < 3_000, `${waited}ms`);
  await halfTunnel.stop();
  // The pair: without a whole body coming back, a channel that fails everything would pass the case above.
  const whole = await relayFetch("/sessions", tokenFor(alice, mine));
  check("while a complete answer is still delivered as one", whole.status, 200);
}


// Two tunnels for one machine, at the registry level over a parked `PassThrough`, so there is no timing in it.

process.stdout.write("\nsuperseding a tunnel\n");
{
  const parked = (): ClientHttp2Session => h2connect("http://tunnel", { createConnection: () => new PassThrough() });
  const sessionA = parked();
  const sessionB = parked();
  const first = new EndpointTunnel("m_super", Date.now(), RELAY_PROTOCOL_VERSION, sessionA, () => sessionA.destroy());
  const second = new EndpointTunnel("m_super", Date.now() + 1, RELAY_PROTOCOL_VERSION, sessionB, () => sessionB.destroy());

  registry.register(first, CLOSE_TUNNEL_SUPERSEDED);
  registry.register(second, CLOSE_TUNNEL_SUPERSEDED);
  // Newest wins: after a partition the relay may still hold a dead socket it cannot detect.
  report("the newest tunnel wins", registry.get("m_super") === second, "the second registration is the live one");
  check("and one machine holds exactly one tunnel", registry.stats().filter((t) => t.machineId === "m_super").length, 1);

  // The superseded tunnel's close fires after its replacement registered, so unregister must check identity.
  registry.unregister(first);
  report("a late close from the superseded one does not unregister the replacement", registry.isOnline("m_super"), "still online");

  registry.unregister(second);
  check("and the registered one still unregisters", registry.isOnline("m_super"), false);
  sessionA.destroy();
  sessionB.destroy();
}

// Streams are budgeted per subject, not per tunnel: one grantee holding them all would make the owner's machine read as gone.

process.stdout.write("\none caller's share of a tunnel\n");
{
  // A peer that discards writes: a `PassThrough` echoes the preface back and breaks the session once a stream opens.
  const nowhere = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const session = h2connect("http://tunnel", { createConnection: () => nowhere });
  session.on("error", () => {});
  const shared = new EndpointTunnel("m_share", Date.now(), RELAY_PROTOCOL_VERSION, session, () => session.destroy());

  // An `error` listener on every stream: teardown emits `ECONNRESET`, and an unhandled `error` is an uncaught exception.
  const hold = (subject: string): ClientHttp2Stream | null => {
    const stream = shared.open(subject, { key: subject, max: MAX_STREAMS_PER_SUBJECT, link: false }, STREAM_ENCRYPTION_NOISE_IK);
    stream?.on("error", () => {});
    return stream;
  };

  const held = [];
  for (let i = 0; i < MAX_STREAMS_PER_SUBJECT; i += 1) held.push(hold("u_greedy"));
  check("a caller may hold its whole share", held.filter((stream) => stream !== null).length, MAX_STREAMS_PER_SUBJECT);
  check("and is refused the one past it", hold("u_greedy"), null);

  report("while somebody else is unaffected", hold("u_owner") !== null, "the owner still gets a stream");

  held[0]?.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  report("a closed stream gives the slot back", hold("u_greedy") !== null, "the slot returned on close");

  shared.close(1000, "done");
  session.destroy();
}

// A link's streams have a key and a ceiling of their own: keyed on the owner, a looping agent would lock them out of their machine (Q7.150).

process.stdout.write("\na link's share of a tunnel\n");
{
  const nowhere = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const session = h2connect("http://tunnel", { createConnection: () => nowhere });
  session.on("error", () => {});
  const shared = new EndpointTunnel("m_linkshare", Date.now(), RELAY_PROTOCOL_VERSION, session, () => session.destroy());

  const person = (subject: string): StreamLimiter => ({ key: subject, max: MAX_STREAMS_PER_SUBJECT, link: false });
  const link = (id: string): StreamLimiter => ({ key: `lnk:${id}`, max: MAX_STREAMS_PER_LINK, link: true });
  // The subject is the owner's on every stream, as the relay stamps it: what is counted is the limiter, never the header.
  const hold = (limiter: StreamLimiter): ClientHttp2Stream | null => {
    const stream = shared.open("u_linkowner", limiter, STREAM_ENCRYPTION_NOISE_IK);
    stream?.on("error", () => {});
    return stream;
  };
  const opened = (streams: (ClientHttp2Stream | null)[]): number => streams.filter((stream) => stream !== null).length;

  const first = Array.from({ length: MAX_STREAMS_PER_LINK }, () => hold(link("lk_first")));
  check("a link may hold its whole share", opened(first), MAX_STREAMS_PER_LINK);
  check("and is refused the one past it", hold(link("lk_first")), null);

  const owners = Array.from({ length: MAX_STREAMS_PER_SUBJECT }, () => hold(person("u_linkowner")));
  check(
    "while the person the link was minted by still holds every stream of their own",
    opened(owners),
    MAX_STREAMS_PER_SUBJECT,
  );
  const second = hold(link("lk_second"));
  report("and another link is unaffected by the first being full", second !== null, "lk_second got a stream");

  // Filled a link's share at a time up to the tunnel's ceiling, so the refusal below is the tunnel's and not a link's.
  const links: (ClientHttp2Stream | null)[] = [...first, second];
  for (let n = 0; opened(links) < MAX_LINK_STREAMS_PER_TUNNEL; n += 1) {
    for (let i = 0; i < MAX_STREAMS_PER_LINK && opened(links) < MAX_LINK_STREAMS_PER_TUNNEL; i += 1) {
      links.push(hold(link(`lk_fill_${n}`)));
    }
  }
  check("every link together is held to one ceiling per tunnel", opened(links), MAX_LINK_STREAMS_PER_TUNNEL);
  check("so a link with none of its own share spent is refused past it", hold(link("lk_late")), null);
  report("while a person still gets a stream on the same tunnel", hold(person("u_someone_else")) !== null, "not counted");

  links.at(-1)?.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  report("and a closed link stream gives the tunnel's slot back", hold(link("lk_late")) !== null, "lk_late got one");

  shared.close(1000, "done");
  session.destroy();
}

// Per link, on the relay's own clock: the caller is a machine that never sleeps.

process.stdout.write("\na link's connect budget\n");
{
  const budget = new LinkConnectBudget();
  const burst = Array.from({ length: LINK_CONNECT_BURST }, () => budget.take("lnk:lk_a", 0));
  check("a link may open a burst of channels at once", burst.filter(Boolean).length, LINK_CONNECT_BURST);
  check("and is refused the one past it", budget.take("lnk:lk_a", 0), false);
  check("while another link spends its own", budget.take("lnk:lk_b", 0), true);
  check(
    "one more is allowed a refill interval later, and only one",
    [budget.take("lnk:lk_a", LINK_CONNECT_REFILL_MS), budget.take("lnk:lk_a", LINK_CONNECT_REFILL_MS)],
    [true, false],
  );
  const refilled = Array.from({ length: LINK_CONNECT_BURST + 1 }, () =>
    budget.take("lnk:lk_a", LINK_CONNECT_REFILL_MS * (LINK_CONNECT_BURST + 1)),
  );
  check("and the whole burst after long enough, never more", refilled.filter(Boolean).length, LINK_CONNECT_BURST);

  const stepped = new LinkConnectBudget();
  for (let i = 0; i < LINK_CONNECT_BURST - 1; i += 1) stepped.take("lnk:lk_c", 10_000);
  check("a clock stepped backwards drains nothing that was left", stepped.take("lnk:lk_c", 5_000), true);
  check("and refills nothing either", stepped.take("lnk:lk_c", 5_000), false);

  // Swept every 256 takes: a bucket that has refilled is the same as none, so the map holds only links that are spending.
  const swept = new LinkConnectBudget();
  for (let i = 0; i < 300; i += 1) swept.take(`lnk:lk_many_${i}`, 0);
  check("buckets are kept while they are short", swept.size, 300);
  const later = LINK_CONNECT_REFILL_MS * LINK_CONNECT_BURST;
  for (let i = 300; i < 512; i += 1) swept.take("lnk:lk_hot", later);
  check("and forgotten once refilled, leaving the one still spending", swept.size, 1);
}

// The relay reads live rows, so a revocation takes effect immediately rather than at token expiry.

process.stdout.write("\nrevocation, immediately\n");
{
  const before = proxied(mine);
  const token = tokenFor(alice, mine);
  check("authorized while the grant exists", (await relayFetch("/sessions", token)).status, 200);

  db.prepare("DELETE FROM grants WHERE user_id = ? AND machine_id = ?").run(alice, mine);
  check("and refused the moment the grant is gone", (await relayFetch("/sessions", token)).status, 404);

  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, '', ?)").run(
    alice,
    mine,
    Date.now(),
  );
  check("a grant with no usable scopes is 403, not 404", (await relayFetch("/sessions", token)).status, 403);

  db.prepare("UPDATE grants SET scopes = 'session:read session:write' WHERE user_id = ? AND machine_id = ?").run(alice, mine);
  db.prepare("UPDATE machines SET revoked_at = ? WHERE id = ?").run(Date.now(), mine);
  // A revoked machine answers as an unknown one, so a token cannot enumerate machines.
  check("a revoked machine is indistinguishable from an unknown one", (await relayFetch("/sessions", token)).status, 404);

  db.prepare("UPDATE machines SET revoked_at = NULL WHERE id = ?").run(mine);
  check("and un-revoking restores the path", (await relayFetch("/sessions", token)).status, 200);
  report("only the two authorized requests touched the tunnel", proxied(mine) - before === 2, `${proxied(mine) - before} streams`);
}

process.stdout.write("\nover the machine limit, immediately\n");
{
  const before = proxied(mine);
  const token = tokenFor(alice, mine);

  // `mine` is ownerless in this fixture; alice owns it for the length of this block.
  db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
    mine,
    alice,
    "relaymine",
    Date.now(),
  );

  check("authorized while they are within their limit", (await relayFetch("/sessions", token)).status, 200);

  writeMachineLimit(db, alice, 0, "u_admin");
  const refused = await relayFetch("/sessions", token);
  check("and refused the moment their limit drops below it", refused.status, 403);
  report(
    "with a code that says which of the reversible states this is",
    refused.body.includes("machine_over_limit"),
    refused.body.slice(0, 120),
  );
  // A refused upgrade has only a status line, so a channel refusal carries the code and no remedy sentence.
  check("and the refusal carries a code rather than prose, because an upgrade has no body", refused.body, "machine_over_limit");

  // The limit is checked after the grant: a caller without one must get the shared 404, or any token probes machines.
  const stranger = addUser("u_overlimit_stranger");
  check(
    "a caller with no grant still gets the shared 404, not a policy 403",
    (await relayFetch("/sessions", tokenFor(stranger, mine))).status,
    404,
  );

  // Suspension is derived, not stored: raising the limit alone restores the path.
  writeMachineLimit(db, alice, 5, "u_admin");
  check("raising the limit restores the path, same token, nothing else touched", (await relayFetch("/sessions", token)).status, 200);

  {
    // The owner's ban gates the machine too; driven through a grantee since a banned owner cannot pass `callerAuth`.
    const grantee = addUser("u_overlimit_grantee");
    grant(grantee, mine);
    const granteeToken = tokenFor(grantee, mine);
    check("a grantee reaches it while the owner is in good standing", (await relayFetch("/sessions", granteeToken)).status, 200);

    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(Date.now(), alice);
    const refusedByBan = await relayFetch("/sessions", granteeToken);
    check("and is refused the moment the owner is banned", refusedByBan.status, 403);
    // `owner_disabled`, never `user_disabled`: the client signs out on the latter, which would eject an innocent grantee.
    report(
      "with a code about the owner rather than about the caller",
      refusedByBan.body.includes("owner_disabled") && !refusedByBan.body.includes("user_disabled"),
      refusedByBan.body.slice(0, 140),
    );

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
  report("only the authorized requests touched the tunnel", proxied(mine) - before === 4, `${proxied(mine) - before} streams`);
}

// `reemoat-enc` is negotiated per stream: an unrecognised value costs one stream, never the tunnel.

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
  // The disagreeing arm of the per-stream version check, driven with a version no build speaks.
  check(
    "a stream version the tunnel did not agree costs one stream, not the tunnel",
    await statusOf({
      ":method": "CONNECT",
      ":authority": "daemon",
      [STREAM_VERSION_HEADER]: "99",
      // Stamped with the mode the daemon speaks, so only the version arm refuses: `none` is a 501 by itself.
      [STREAM_ENCRYPTION_HEADER]: STREAM_ENCRYPTION_NOISE_IK,
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
      [STREAM_ENCRYPTION_HEADER]: STREAM_ENCRYPTION_NOISE_IK,
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

// The relay's half of the encrypted channel: it authorizes, then splices bytes it holds no key for.
// The app's half is packages/web/scripts/webcheck.e2ee.ts.

process.stdout.write("\nthe encrypted channel\n");
{
  /** Open a channel and report what the relay answered, without upgrading past it. */
  const channel = (query: string): Promise<number | "connected"> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}${query}`);
      ws.on("open", () => {
        ws.terminate();
        resolve("connected");
      });
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate();
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => resolve(0));
      setTimeout(() => {
        ws.terminate();
        resolve(-1);
      }, 6_000).unref();
    });

  check("a channel with no credential is refused", await channel(""), 401);
  check("a made-up one too", await channel("?token=not-a-jws"), 401);
  // 404, not 403: a caller with no grant is not told the machine exists, and the channel is the only way in.
  check(
    "and one for a machine this caller has no grant on is not even told it exists",
    await channel(`?token=${encodeURIComponent(tokenFor(mallory, mine))}`),
    404,
  );

  // With no machine key the daemon answers 501 on the stream, and the relay answers the upgrade with it before completing the WebSocket.
  // An opaque close would read as a network drop and be retried for ever.
  const keyless = addMachine("m_keyless");
  grant(alice, keyless);
  const keylessTunnel = RelayTunnel.start({
    relayUrl,
    tunnelKey: issueTunnelKey(db, keyless),
    local: { host: "127.0.0.1", port: daemonPort },
  });
  check("a daemon with no machine key still dials in", await waitForTunnel(keyless), true);

  const before = proxied(keyless);
  check(
    "but a caller is refused at the upgrade rather than at the stream",
    await channel(`?token=${encodeURIComponent(tokenFor(alice, keyless))}`),
    501,
  );
  report(
    "and the refusal was decided after authorization, on a stream this tunnel opened",
    proxied(keyless) - before === 1,
    `${proxied(keyless) - before} streams`,
  );
  await keylessTunnel.stop();

  // Its own granted machine with no tunnel, so the 503 is about the tunnel and not a missing grant.
  const asleep = addMachine("m_asleep");
  grant(alice, asleep);
  check(
    "a machine holding no tunnel is a 503, never a queue",
    await channel(`?token=${encodeURIComponent(tokenFor(alice, asleep))}`),
    503,
  );
}

{
  // End to end through the shipped relay: proves this splice carries a Noise handshake, which neither other driver can see.
  const encrypted = addMachine("m_encrypted");
  grant(alice, encrypted);
  const encryptedTunnelKey = issueTunnelKey(db, encrypted);
  const machineStatic = generateStaticKey();
  const deviceStatic = generateStaticKey();

  const encryptedTunnel = RelayTunnel.start({
    relayUrl,
    tunnelKey: encryptedTunnelKey,
    local: { host: "127.0.0.1", port: daemonPort },
    staticKey: localStaticKey(machineStatic.secretKey),
    // The capability names a key and the handshake authenticated one; the verifier compares them with no lookup.
    verifier: new SignedTokenVerifier({
      identity: {
        machineId: encrypted,
        issuer: ISSUER,
        keys: [{ kid: signing.kid, jwk: signing.jwk }],
      },
    }),
  });
  check("a daemon holding a machine key dials in", await waitForTunnel(encrypted), true);

  const seconds = Math.floor(Date.now() / 1000);
  const bound = signToken(
    {
      iss: ISSUER,
      sub: alice,
      aud: encrypted,
      jti: "t_channel",
      iat: seconds,
      nbf: seconds,
      exp: seconds + 300,
      scp: ["session:read"],
      cnf: { jkt: jwkThumbprint(x25519Jwk(deviceStatic.publicKey)) },
    },
    signing.kid,
    signing.privateKey,
  );

  const outcome = await new Promise<{ ready: boolean; carried: string }>((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${relayPort}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(bound)}`,
    );
    const reader = new LengthReader();
    const handshake = NoiseHandshake.start({
      initiator: true,
      staticKey: localStaticKey(deviceStatic.secretKey),
      remoteStatic: machineStatic.publicKey,
    });
    let send: CipherState | null = null;
    let receive: CipherState | null = null;
    const seen: Buffer[] = [];
    // Record both directions: the capability travels outbound, so a receive-only buffer could never contain it.
    const sendRecorded = (bytes: Uint8Array): void => {
      seen.push(Buffer.from(bytes));
      ws.send(bytes);
    };
    const give = (ready: boolean): void => {
      ws.terminate();
      resolve({ ready, carried: Buffer.concat(seen).toString("latin1") });
    };
    const timer = setTimeout(() => give(false), 8_000);
    timer.unref();

    ws.on("open", () => {
      void handshake.writeMessage().then((first: Uint8Array) => sendRecorded(frameLength(first)));
    });
    ws.on("message", (data: Buffer) => {
      seen.push(data);
      for (const message of reader.push(new Uint8Array(data))) {
        if (send === null) {
          void handshake.readMessage(message).then(() => {
            const transport = handshake.split();
            send = transport.send;
            receive = transport.receive;
            // The capability rides the first transport message, never the handshake payload, which lacks forward secrecy and is replayable.
            sendRecorded(
              frameLength(send.encrypt(new Uint8Array(0), encodeJsonFrame(FRAME.HELLO, { capability: bound }))),
            );
          });
          continue;
        }
        try {
          const frame = decodeFrame(receive!.decrypt(new Uint8Array(0), message));
          if (frame?.type === FRAME.READY) {
            clearTimeout(timer);
            give(true);
          }
        } catch {
          clearTimeout(timer);
          give(false);
        }
      }
    });
    ws.on("unexpected-response", () => give(false));
    ws.on("error", () => give(false));
  });

  report("a Noise handshake completes through the relay's splice", outcome.ready, "READY");
  // No JWS prefix in anything that crossed; the control first proves the search could find one.
  check(
    "the search would find the capability if it were in the clear",
    Buffer.from(bound, "utf8").toString("latin1").includes("eyJ"),
    true,
  );
  check("and the capability it carried is not readable in what crossed", outcome.carried.includes("eyJ"), false);
  report("in bytes this end wrote as well as bytes it read", outcome.carried.length > 0, `${outcome.carried.length} bytes`);

  encryptedTunnel.stop();
}

// A stream is stamped with the version its tunnel negotiated, asserted with one this build does not speak.

process.stdout.write("\nwhat a stream is stamped with\n");
{
  // Typed `number`: with a literal type tsc flags the comparison below as unintentional.
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
  const stream = held.open("u_someone", { key: "u_someone", max: MAX_STREAMS_PER_SUBJECT, link: false }, STREAM_ENCRYPTION_NOISE_IK);
  // Awaited on the response: an unref'd timer lets the process exit before the assertion runs.
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


// The relay answers its own health path; the daemon's stays proxied, or every probe would pass against a relay carrying nothing.

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

  // `database` is the field that can go red; asserted as a field because this driver's database is shared by every later section.
  report("with a field that can say otherwise", typeof body["database"] === "string", `database: ${String(body["database"])}`);

  // No credential on this path, so it must not reveal who is connected.
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

// `relayOnline` reads a table the relay writes, since the API process holds no `TunnelRegistry`.

process.stdout.write("\ntunnel presence, as a row\n");
{
  let clock = 1_000_000;
  const presence = createPresenceWriter(db, { relayId: DEFAULT_RELAY_ID, now: () => clock });
  const view = dbRelayView(db, { now: () => clock });
  const rows = (): unknown[] => db.prepare("SELECT machine_id, relay_id, connected_at, last_seen_at FROM relay_tunnels ORDER BY machine_id").all();

  presence.clear();
  check("a relay clears its own rows at boot, because it cannot have any yet", rows(), []);

  // `machine_last_seen` survives the tunnel row, which is deleted on disconnect.
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

  // Newest wins as one row, as in the registry's map.
  presence.up("m_one", clock - 1_000);
  check("a supersede overwrites rather than duplicating", rows().length, 1);
  check("and the row is the newer tunnel's", view.stats()[0]?.since, clock - 1_000);

  check("and dialling in is recorded where the tunnel row cannot reach", lastSeen("m_one"), clock);

  presence.down("m_one");
  check("unregistering removes it", [rows(), view.isOnline("m_one")], [[], false]);
  check("but when it was last there survives the disconnect", lastSeen("m_one"), clock);

  // A flush stamps everything live with one `at` and sweeps what it did not stamp, so a lost up or down costs one tick.
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

  // Staleness errs toward online: a stale true costs a probe and a 503, a stale false hides a reachable machine.
  clock += PRESENCE_STALE_MS;
  check("a row exactly at the window is still believed", view.isOnline("m_two"), true);
  clock += 1;
  check("and one past it is not, for either reader", [view.isOnline("m_two"), view.stats()], [false, []]);
  check("though the row is still there to be swept by whoever replaces this relay", rows().length, 1);

  // A relay id is a slot: only the relay under that id clears its rows.
  const other = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
  other.up("m_three", clock);
  presence.clear();
  check("clearing takes only the rows this relay id owns", rows().length, 1);
  check("and that survivor is the other relay's", view.stats().map((row) => row.machineId), ["m_three"]);

  // `dbRelayView` names the relay holding a machine, which a per-process `TunnelRegistry` cannot.
  check("a reader can name the relay holding a machine", view.relayFor("m_three"), "relay-2");
  check("and answers nothing for a machine with no tunnel", view.relayFor("m_nobody"), null);
  // `relayFor` uses the staleness window of `isOnline`: a row counted absent must name nowhere to dial.
  clock += PRESENCE_STALE_MS + 1;
  check("a row past the window names nobody either", [view.isOnline("m_three"), view.relayFor("m_three")], [false, null]);
  clock -= PRESENCE_STALE_MS + 1;

  other.clear();
  check("which its own owner can then take", rows(), []);

  // Through the registry: the row inherits the map's identity check, so a displaced tunnel's late close keeps the replacement's row.
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

  // `closeAll` clears the map, making later unregisters no-ops, so it must delete the rows itself.
  mirrored.closeAll(CLOSE_TUNNEL_SUPERSEDED, "relay shutting down");
  check("and stopping the relay takes its rows with it", [view.isOnline("m_mirror"), rows()], [false, []]);
  sessionA.destroy();
  sessionB.destroy();

  // One live process per relay id, since two would sweep each other's rows; liveness is a heartbeat, not a pid, as relays run in containers.
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
    // Re-claiming under the same nonce is a restart of the holder, not a collision.
    check("the holder can re-claim its own slot", claimRelayId(db, "relay-slot", "nonce-a", claimClock.at + 2_000).ok, true);
    // The re-claim refreshed `last_seen_at`, so the window runs from there.
    const afterReclaim = claimClock.at + 2_000;
    // Taking over a stale claim is the normal path: a hard-killed relay leaves its row behind.
    check(
      "a claim past the window is taken over",
      claimRelayId(db, "relay-slot", "nonce-c", afterReclaim + RELAY_CLAIM_STALE_MS + 1).ok,
      true,
    );
    // Release is identity-checked, or a relay refused at boot would clear the live holder's claim.
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

// Tunnels are in memory per relay, so the token route must name the holding relay's URL or requests land on one that answers 503.

process.stdout.write("\nrouting a browser to the relay that holds the machine\n");
{
  // Only http and https: a URL parser reads a bare host:port as a scheme, and `streamUrl` makes anything not https a plaintext ws socket.
  // These live in relay/routing.ts because importing main.ts starts a listener.
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
  // A duplicate id is a copy-paste; last-wins would silently misroute every browser for that relay.
  check("a duplicate id is refused rather than resolved", parseRelayUrls("r=https://a.example,r=https://b.example"), "invalid");
  check("a value the browser cannot dial is refused", parseRelayUrls("r=wss://a.example"), "invalid");
  check("and a value that is nothing but commas is not an empty fleet", parseRelayUrls(",,"), "invalid");
  // Parsed into a null-prototype object, so a slot named after a prototype member is ordinary.
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

  // No tunnel: the default URL rides beside `relayOnline: false`; a null would be a field no client is typed for.
  check("a machine with no tunnel gets the shared name", await mint(), DEFAULT_URL);

  presence.up(machineId, clock);
  check("and one held by a relay gets that relay's own", await mint(), "https://r2.example");

  const stray = createPresenceWriter(db, { relayId: "relay-9", now: () => clock });
  stray.up(machineId, clock);
  check("a relay the map does not name falls back rather than answering nothing", await mint(), DEFAULT_URL);

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

  // `relayUrlFor` also serves the machines listing, which the client re-reads every poll, so a regression there clobbers the route continuously.
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

  // A stale relay must not steal the row back: the flush transfers ownership only to a strictly newer `connected_at`.
  const relayA = createPresenceWriter(db, { relayId: "relay-2", now: () => clock });
  const relayB = createPresenceWriter(db, { relayId: "relay-3", now: () => clock });
  relayB.up(machineId, clock + 5_000); // the redial, strictly newer
  check("a redial moves the row to the relay that took it", view.relayFor(machineId), "relay-3");
  relayA.flush([
    { machineId, relayId: "relay-2", since: clock, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("and the relay it left cannot take it back on a heartbeat", view.relayFor(machineId), "relay-3");
  // The pair: a newer tunnel whose `up` write was lost still claims the row through the flush.
  relayA.flush([
    { machineId, relayId: "relay-2", since: clock + 9_000, activeStreams: 0, requestsProxied: 0 },
  ]);
  check("while a newer tunnel still claims it through the flush", view.relayFor(machineId), "relay-2");

  relayA.clear();
  relayB.clear();

  // `unmapped` names a relay id holding tunnels with no URL entry, which otherwise degrades silently to the shared URL.
  {
    const stranger = createPresenceWriter(db, { relayId: "relay-unlisted", now: () => clock });
    stranger.up(machineId, clock);
    const seen = (await (
      await routed.request("/v1/admin/relay", { headers: { authorization: `Bearer ${adminKey.key}` } })
    ).json()) as { unmapped: string[]; tunnels: { relayId: string }[] };
    check("a relay holding tunnels with no entry in the map is named", seen.unmapped, ["relay-unlisted"]);
    check("and the listing says which relay each tunnel is on", seen.tunnels.map((t) => t.relayId), ["relay-unlisted"]);

    // Empty with no map: the single-relay shape must not warn about itself.
    const plain = (await (
      await single.request("/v1/admin/relay", { headers: { authorization: `Bearer ${adminKey.key}` } })
    ).json()) as { unmapped: string[] };
    check("while an unconfigured fleet warns about nothing", plain.unmapped, []);
    stranger.clear();
  }

  presence.clear();

  // Two machines on two relays in one listing: the URL must resolve per row, not once per request.
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

    // Both `relayUrlFor` call sites must agree per machine, or the client flips relay every poll.
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

  // `flush` re-stamps `relay_instances.last_seen_at`, the heartbeat that keeps a relay's slot claimed.
  {
    let at = 5_000_000;
    check("a relay takes its slot", claimRelayId(db, "beat-idle", "nonce-a", at).ok, true);

    at += RELAY_CLAIM_STALE_MS + 1_000;
    check("and goes stale if nothing keeps it", claimRelayId(db, "beat-idle", "nonce-b", at).ok, true);

    // A flush with no tunnels must still stamp: a relay holding none still owns its name.
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

    // The stamp is identity-checked: a relay whose claim was taken over must not stamp it back.
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

// The `/v1` surface, driven in process against this database; the machine-key repair also dials the live loopback relay.

// The Authority holds identity and machines, never the work (docs/AUTHORITY.md); both halves below are ratchets against the current tree.

process.stdout.write("\nwhat the Authority may reach\n");
{
  // The Authority reaches the repository root only for wire vocabulary: the files `deploy/docker/Dockerfile` copies into the image.
  const ALLOWED = ["src/auth.js", "src/cors.js", "src/http.js", "src/relay/protocol.js", "src/token.js"];

  const cpSrc = new URL("../packages/control-plane/src/", import.meta.url);
  const walk = (dir: URL): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...walk(new URL(`${entry.name}/`, dir)));
      else if (entry.name.endsWith(".ts")) out.push(readFileSync(new URL(entry.name, dir), "utf8"));
    }
    return out;
  };
  const sources = walk(cpSrc);
  report("there are sources to sweep at all", sources.length > 5, `${String(sources.length)} files`);

  // Any number of `../`: the depth differs between `src/` and `src/relay/`.
  const reached = [
    ...new Set(
      sources.flatMap((text) => [...text.matchAll(/from "(?:\.\.\/)+(src\/[^"]+)"/g)].map((m) => m[1] ?? "")),
    ),
  ].sort();
  report("and imports that climb out were found", reached.length > 0, reached.join(", "));
  check("the Authority reaches exactly the wire vocabulary and nothing else", reached, ALLOWED);
  check(
    "nothing it imports is a session, a registry, an agent or a runtime",
    reached.filter((path) => /^src\/(session|registry|acp\/|runtime\/)/.test(path)),
    [],
  );

  // No route may name an agent's work; read off `app.ts`'s own registrations.
  const appTs = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
  const paths = [
    ...new Set([...appTs.matchAll(/^\s*app\.(?:get|post|put|patch|delete)\("([^"]+)"/gm)].map((m) => m[1] ?? "")),
  ];
  report("the route table was readable", paths.length > 20, `${String(paths.length)} routes`);
  check(
    "no route here names an agent's work",
    paths.filter((path) => /\/(sessions?|prompts?|agents?|worktrees?|files?|diffs?|events?)(\/|$)/.test(path)).sort(),
    [
      // The `/v1/me/sessions` routes are sign-ins, listed by name so the pattern still refuses `/v1/sessions`.
      "/v1/me/sessions",
      "/v1/me/sessions/:id",
      "/v1/me/sessions/current",
    ],
  );
}

// The served gate paths are hand mirrors of `GATE_SCREENS` and `LEGAL_DOCS`, plus the handoff the other way: a missing path is a dead link in an email.

process.stdout.write("\nthe gate's addresses, on both sides\n");
{
  const appSource = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
  const clientList = (file: string, name: string): string[] => {
    const text = readFileSync(new URL(`../packages/web/src/${file}`, import.meta.url), "utf8");
    const found = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(text)?.[1] ?? "";
    return [...found.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").sort();
  };
  const serverList = (name: string): string[] => {
    const found = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(appSource)?.[1] ?? "";
    return [...found.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").sort();
  };

  const screensClient = clientList("gate.ts", "GATE_SCREENS");
  const screensServer = serverList("GATE_SCREEN_PATHS");
  report("both sides of the screen list were read", screensClient.length > 0 && screensServer.length > 0, screensClient.join(","));
  check("every gate screen the client can draw is a path the server serves", screensServer, screensClient);

  const docsClient = clientList("legal.ts", "LEGAL_DOCS");
  const docsServer = serverList("LEGAL_DOC_PATHS");
  report("and both sides of the document list", docsClient.length > 0 && docsServer.length > 0, docsClient.join(","));
  check("every legal document likewise", docsServer, docsClient);

  const handoff = /const APP_HANDOFF_PATH = "([^"]+)"/.exec(appSource)?.[1] ?? "";
  report("the handoff has an address", handoff.length > 0, `/${handoff}`);
  check("which is neither a screen nor a document", [...screensClient, ...docsClient].includes(handoff), false);

  // Compared against the slash-prefixed server value so a double miss fails; comment-stripped since `APP_HANDOFF_PATH` contains `HANDOFF_PATH`.
  const cardSource = readFileSync(new URL("../packages/web/src/ui/gate/GateCard.tsx", import.meta.url), "utf8");
  const cardCode = cardSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const clientHandoff = /const HANDOFF_PATH = "([^"]+)"/.exec(cardCode)?.[1] ?? "";
  report("the client names the handoff too", clientHandoff.length > 0, clientHandoff);
  check("and it is the server's address with the slash the server adds", clientHandoff, `/${handoff}`);

  // Every gate navigation names its destination, never a literal; parsed-against-raw count equality over comment-stripped source is the non-vacuity guard.
  const gateDir = new URL("../packages/web/src/ui/gate/", import.meta.url);
  let gateFiles: string[] = [];
  try {
    gateFiles = readdirSync(gateDir)
      .filter((file) => /\.tsx?$/.test(file))
      .sort();
  } catch {
    // Left empty so the report below fails in place instead of killing the run.
  }
  let navCalls = 0;
  const destinations: string[] = [];
  for (const entry of gateFiles) {
    const code = readFileSync(new URL(entry, gateDir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    navCalls += (code.match(/navigate\(/g) ?? []).length;
    destinations.push(...[...code.matchAll(/navigate\(\s*([^,)]+)/g)].map((found) => (found[1] ?? "").trim()));
  }
  report("the gate's ways off a screen were read", destinations.length > 0, destinations.join(", "));
  check("every navigation in the gate had its destination parsed", destinations.length, navCalls);
  check(
    "none of them writes an address inline instead of naming it",
    destinations.filter((where) => /^["'`]/.test(where)),
    [],
  );
  check("and the handoff is reached through the constant just compared", destinations.includes("HANDOFF_PATH"), true);
}

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

  // `app.request` may answer without a promise; `Promise.resolve` keeps every call site a plain await.
  const patch = async (id: string, body: unknown): Promise<Response> =>
    Promise.resolve(
      app.request(`/v1/admin/machines/${id}`, { method: "PATCH", headers: admin, body: JSON.stringify(body) }),
    );
  const nameOf = async (response: Response): Promise<unknown> =>
    ((await response.json()) as { name: unknown }).name;

  check("an unauthenticated admin route is refused", (await app.request("/v1/admin/machines")).status, 401);

  // A machine has no address in the registry; renaming is all that is left to assert here.
  check("a machine can be renamed", await nameOf(await patch(mine, { name: "renamed" })), "renamed");
  // Renamed back to its id: later sections resolve a machine by either.
  check("and renamed back", await nameOf(await patch(mine, { name: mine })), mine);
  check("an absent field changes nothing", await nameOf(await patch(mine, {})), mine);
  check("a name clash is a 409", (await patch(mine, { name: other })).status, 409);
  check("an unknown machine is a 404", (await patch("m_nope", { name: "x" })).status, 404);
  check(
    "and no machine route reports an address",
    Object.keys((await (await patch(mine, {})).json()) as Record<string, unknown>).includes("baseUrl"),
    false,
  );

  const listed = (await (await app.request("/v1/admin/machines", { headers: admin })).json()) as {
    machines: Record<string, unknown>[];
  };
  const patched = (await (await patch(mine, {})).json()) as Record<string, unknown>;
  report(
    "PATCH and GET describe a machine the same way",
    JSON.stringify(Object.keys(patched).sort()) === JSON.stringify(Object.keys(listed.machines[0] ?? {}).sort()),
    Object.keys(patched).sort().join(","),
  );

  // Single use through one conditional UPDATE: of two concurrent redemptions exactly one wins.
  // Its own machine: redeeming retires the tunnel credential, which would cut the tunnel later sections ride.
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

  // Drives the enroll route itself: re-enrolling with an announced `machineKey` is the only way back from a mismatched pin.
  {
    const rekeyed = addMachine("m_rekey");
    const announced = "R".repeat(MAX_MACHINE_KEY_CHARS);
    const codeFor = async (): Promise<string> =>
      (
        (await (
          await app.request(`/v1/admin/machines/${rekeyed}/enrollments`, { method: "POST", headers: admin })
        ).json()) as { code: string }
      ).code;
    const enrollWith = async (body: Record<string, unknown>): Promise<number> =>
      (
        await app.request("/v1/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status;

    check("a machine starts with no pinned key", machineKeyFor(db, rekeyed), null);
    check("redeeming a code that announces one records it", await enrollWith({ code: await codeFor(), machineKey: announced }), 200);
    check("and the key the route pinned is the one that was announced", machineKeyFor(db, rekeyed), announced);

    const restarted = "S".repeat(MAX_MACHINE_KEY_CHARS);
    check("re-enrolling with a different key replaces the pin", await enrollWith({ code: await codeFor(), machineKey: restarted }), 200);
    check("which is what makes a lost database recoverable", machineKeyFor(db, rekeyed), restarted);

    check("a redemption that announces no key is still accepted", await enrollWith({ code: await codeFor() }), 200);
    check("and leaves the pin exactly as it was", machineKeyFor(db, rekeyed), restarted);
  }

  // scripts/daemon.ts starts a daemon, so no driver imports it: its enroll call is read as source.
  {
    const daemonSrc = readFileSync(new URL("../scripts/daemon.ts", import.meta.url), "utf8");
    const call = /await enroll\(\{([^}]*)\}\)/.exec(daemonSrc);
    report("the daemon's enroll call was found to read", call !== null, call === null ? "not found" : call[1]!.trim());
    check("and it announces the machine key it just ensured", /machineKey:\s*machineKey\.publicKey/.test(call?.[1] ?? ""), true);
  }

  // The machine-key DELETE route, driven through the relay on both sides; the 409 before the clear is the negative control.
  {
    const clearable = addMachine("m_clearpin");
    const dialVersion = String(RELAY_PROTOCOL_VERSION);
    const pinned = "C".repeat(MAX_MACHINE_KEY_CHARS);
    const restarted = "D".repeat(MAX_MACHINE_KEY_CHARS);
    const outcome = async (response: Response): Promise<[number, string]> => [
      response.status,
      ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
    ];
    const clearKey = (machineId: string, headers: Record<string, string>): Promise<Response> =>
      Promise.resolve(app.request(`/v1/admin/machines/${machineId}/machine-key`, { method: "DELETE", headers }));

    const enrollmentCode = (
      (await (
        await app.request(`/v1/admin/machines/${clearable}/enrollments`, { method: "POST", headers: admin })
      ).json()) as { code: string }
    ).code;
    const enrolled = (await (
      await app.request("/v1/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: enrollmentCode, machineKey: pinned }),
      })
    ).json()) as { tunnelKey: string };
    check("the machine this route repairs starts out pinned", machineKeyFor(db, clearable), pinned);

    check(
      "a daemon announcing a different key is stuck at 409",
      await tryTunnel(enrolled.tunnelKey, dialVersion, restarted),
      409,
    );

    // Refusals first, so each is measured against a pin that is still there.
    const bystander = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_alice', ?, ?, ?)").run(
      newId("ak"),
      bystander.prefix,
      bystander.hash,
      now,
    );
    check(
      "somebody who is not an admin cannot clear a pin",
      await outcome(await clearKey(clearable, { authorization: `Bearer ${bystander.key}` })),
      [403, "forbidden"],
    );
    check("and an unauthenticated caller is refused before the machine is looked up", (await clearKey("m_nope", {})).status, 401);
    check("an unknown machine is a 404 here too", await outcome(await clearKey("m_nope", admin)), [404, "machine_not_found"]);
    check("and none of those refusals moved the pin", machineKeyFor(db, clearable), pinned);

    // Its own machine, left revoked: revoking one a later section dials would break that section.
    const revoked = addMachine("m_clearpin_revoked");
    setMachineKey(db, revoked, pinned);
    db.prepare("UPDATE machines SET revoked_at = ? WHERE id = ?").run(now, revoked);
    check("a revoked machine is refused", await outcome(await clearKey(revoked, admin)), [403, "machine_revoked"]);
    check("and keeps whatever was pinned for it", machineKeyFor(db, revoked), pinned);

    // Compared whole and by value: previousKey must be read before the UPDATE, which a shape check would miss.
    const cleared = await clearKey(clearable, admin);
    check("clearing answers 200", cleared.status, 200);
    check("with the machine, the fact, and the key that was there", await cleared.json(), {
      machineId: clearable,
      cleared: true,
      previousKey: pinned,
    });
    check("and the row now holds no pin", machineKeyFor(db, clearable), null);

    const again = await clearKey(clearable, admin);
    check("clearing again is not an error", again.status, 200);
    check("and says plainly that nothing changed", await again.json(), {
      machineId: clearable,
      cleared: false,
      previousKey: null,
    });

    check(
      "the dial that was stuck now connects",
      await tryTunnel(enrolled.tunnelKey, dialVersion, restarted),
      "connected",
    );
    check("and the key it announced is the new pin", machineKeyFor(db, clearable), restarted);
  }

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

// Slow by design (about forty scrypt runs); fresh machines throughout, since redeeming a code retires a machine's tunnel key.

process.stdout.write("\nsigning in, sessions and passwords\n");
{
  // Proxied (one trusted hop) so the driver stands in for the proxy and callers can have distinct addresses.
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
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];
  const login = (name: string, password: string): Promise<Response> =>
    post("/v1/login", { name, password }, { "content-type": "application/json" });

  check("an unauthenticated /v1/me/password is refused", (await send("/v1/me/password", { method: "POST" })).status, 401);
  check(
    "so is minting an enrollment code for a machine",
    (await send("/v1/machines/m_x/enrollments", { method: "POST" })).status,
    401,
  );
  check("so is signing out", (await send("/v1/me/sessions/current", { method: "DELETE" })).status, 401);
  check("so is creating a machine", (await send("/v1/machines", { method: "POST" })).status, 401);
  // Code-minting routes must honour a trusted x-forwarded-proto, or a daemon behind a TLS proxy is told to dial http (Q1.627).
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
    // Negative control: with no proxy declared the caller-supplied header is ignored.
    const bare = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const forged = (await (
      await bare.request("/v1/machines", {
        method: "POST",
        headers: { ...proxied },
        body: JSON.stringify({ name: "forged-origin" }),
      })
    ).json()) as { controlPlaneUrl?: string };
    check("while an undeclared proxy's header moves nothing", forged.controlPlaneUrl?.startsWith("http://"), true);
    // Read like x-forwarded-for: the entry trustedHops from the right.
    const appended = (await (
      await post("/v1/machines", { name: "appended-proto" }, { ...admin, "x-forwarded-proto": "http, https" })
    ).json()) as { machine?: { id?: string }; controlPlaneUrl?: string };
    check("and with a proxy that appends, the proxy's entry outranks the client's", appended.controlPlaneUrl?.startsWith("https://"), true);
    const short = (await (
      await post("/v1/machines", { name: "short-chain" }, { ...admin, "x-forwarded-proto": "" })
    ).json()) as { controlPlaneUrl?: string };
    check("and a header with fewer entries than hops is not believed", short.controlPlaneUrl?.startsWith("http://"), true);
    // The other two code-minting routes: the admin's here, the provisioning key's further down.
    const adminMinted = (await (
      await post(`/v1/admin/machines/${appended.machine?.id ?? "m_missing"}/enrollments`, {}, proxied)
    ).json()) as { controlPlaneUrl?: string };
    check("and a code an admin mints honours it too", adminMinted.controlPlaneUrl?.startsWith("https://"), true);
    // Two hops, because at one hop the right-most entry is also the correct one; each header makes left-most, right-most and correct reads disagree.
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
  // Health does one real read so it can fail; an absent signing key is not failure, since the relay may create the schema first.
  const health = (await (await send("/health")).json()) as Record<string, unknown>;
  check("and reports whether it can read its own database", [health["ok"], health["database"]], [true, "ok"]);
  check(
    "an unknown /v1 path is refused rather than 404'd to a stranger",
    (await send("/v1/nope")).status,
    401,
  );

  const madeResponse = await post("/v1/admin/users", { name: "ada" }, admin);
  const made = (await madeResponse.json()) as { id: string; password: string; apiKey?: string; mustChangePassword?: boolean };
  check("a new user is created with a password", madeResponse.status, 201);
  check("and no API key at all", made.apiKey, undefined);
  const withKey = (await (await post("/v1/admin/users", { name: "bob", withKey: true }, admin)).json()) as {
    id: string;
    password: string;
    apiKey?: string;
  };
  check("asking for one is ignored rather than honoured", withKey.apiKey, undefined);
  check("an admin-created account owes a password change", made.mustChangePassword, true);

  // The password-change wall is asserted here, then cleared in the database so the fixtures below can use the API.
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
    // Routes unrelated to passwords, one of them a write, because the gate must fail closed.
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
    // Again on an API key: the gate is credential-blind, requirePasswordCurrent never reads via.
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
    // Removed: later assertions count ada's live keys.
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
    const everywhere = (await (await login("ada", made.password)).json()) as { token: string };
    check(
      "signing out everywhere stays reachable too",
      (await send("/v1/me/sessions", { method: "DELETE", headers: { authorization: `Bearer ${everywhere.token}` } }))
        .status,
      200,
    );

    // The remedy both ways; the obligation is read from the table, not /v1/me, since both read the same table.
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
    check(
      "and the route that answered 403 a moment earlier now answers",
      (await send("/v1/machines", { headers: remedyBearer })).status,
      200,
    );
    // Put back: every fixture below signs in as ada with made.password.
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

  const signedIn = (await (await login("ada", made.password)).json()) as { token: string };
  check("the right password signs in", typeof signedIn.token, "string");
  check("and the token has the prefix keyPrefix assumes", signedIn.token.slice(0, 3), "rs_");
  check(
    "the stored row is a hash rather than the token",
    db.prepare("SELECT token_hash FROM user_sessions WHERE user_id = ?").get(made.id)?.["token_hash"] !== signedIn.token,
    true,
  );
  check("a session reaches /v1/me", (await send("/v1/me", { headers: bearer(signedIn.token) })).status, 200);
  check("an API key still reaches /v1/me", (await send("/v1/me", { headers: admin })).status, 200);
  check(
    "and /v1/me says which credential it was",
    [
      ((await (await send("/v1/me", { headers: bearer(signedIn.token) })).json()) as { via?: string }).via,
      ((await (await send("/v1/me", { headers: admin })).json()) as { via?: string }).via,
    ],
    ["session", "api_key"],
  );

  const wrongPassword = await outcome(await login("ada", "definitely-not-it"));
  const unknownName = await outcome(await login("nobody-at-all", "definitely-not-it"));
  check("a wrong password is refused", wrongPassword, [401, "invalid_login"]);
  check("and an unknown name is refused identically", unknownName, wrongPassword);
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_nopw', 'nopw', 0, ?)").run(now);
  check("so is a user who has no password at all", await outcome(await login("nopw", "anything-at-all")), wrongPassword);

  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, withKey.id);
  check("a banned user with the right password is told so", await outcome(await login("bob", withKey.password)), [403, "user_disabled"]);
  // Only after the password verified, so this leaks nothing.
  check("but with the wrong one is not", await outcome(await login("bob", "wrong-wrong-wrong")), wrongPassword);
  check("and their live session stops working", await (async () => {
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(withKey.id);
    const live = (await (await login("bob", withKey.password)).json()) as { token: string };
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, withKey.id);
    return outcome(await send("/v1/me", { headers: bearer(live.token) }));
  })(), [403, "user_disabled"]);

  // Refusals are compared to wrongPassword by value: any difference is an oracle for which addresses exist.
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
    check("in whatever case it is typed", await whoIs("ADA@EXAMPLE.COM", made.password), "ada");
    check("and the name still works beside it", await whoIs("ada", made.password), "ada");
    check("a real address with the wrong password reads like everything else", await outcome(await login("ada@example.com", "definitely-not-it")), wrongPassword);
    check("and an address nobody has, likewise", await outcome(await login("nobody@example.com", "definitely-not-it")), wrongPassword);

    // An unverified claim reserves nothing: register is anonymous, hence the partial unique index.
    const carol = (await (await post("/v1/admin/users", { name: "carol" }, admin)).json()) as { id: string; password: string };
    claim(carol.id, "carol@example.com", false);
    check("an unverified address opens nothing", await outcome(await login("carol@example.com", carol.password)), wrongPassword);
    check("while carol's own name still does", await whoIs("carol", carol.password), "carol");

    const mallory = (await (await post("/v1/admin/users", { name: "mallory" }, admin)).json()) as { id: string; password: string };
    claim(mallory.id, "ada@example.com", false);
    check("claiming an address somebody proved does not borrow it", await outcome(await login("ada@example.com", mallory.password)), wrongPassword);
    check("and the account that proved it still signs in", await whoIs("ada@example.com", made.password), "ada");

    db.prepare("DELETE FROM password_obligations WHERE user_id IN (?, ?)").run(carol.id, mallory.id);
  }

  const phone = (await (await login("ada", made.password)).json()) as { token: string };
  check("signing out ends the token it was presented with", (await send("/v1/me/sessions/current", { method: "DELETE", headers: bearer(phone.token) })).status, 200);
  // session_revoked is safe to distinguish: reaching it required a real 256-bit token.
  check("and the code says a session ended", await outcome(await send("/v1/me", { headers: bearer(phone.token) })), [401, "session_revoked"]);
  check("signing out with an API key is a 409", await outcome(await send("/v1/me/sessions/current", { method: "DELETE", headers: admin })), [409, "not_a_session"]);
  check("somebody else's session id is a 404, not a 403", await outcome(await send("/v1/me/sessions/s_nope", { method: "DELETE", headers: bearer(signedIn.token) })), [404, "session_not_found"]);

  // The header is believed only as far as trustedProxyHops says, counted from the right.
  check("with no proxy configured the header is ignored outright", callerAddressOf("203.0.113.7", "10.0.0.9"), "10.0.0.9");
  check("however many entries it carries", callerAddressOf("1.1.1.1, 2.2.2.2, 3.3.3.3", "10.0.0.9"), "10.0.0.9");
  check("one trusted hop takes the entry that proxy appended", callerAddressOf("203.0.113.7, 10.0.0.1", "10.0.0.9", 1), "10.0.0.1");
  check("and not the one the caller wrote", callerAddressOf("203.0.113.7, 10.0.0.1", "10.0.0.9", 1) === "203.0.113.7", false);
  // Two hops is a proxy of yours behind a CDN.
  check("two hops steps one further left", callerAddressOf("evil, 203.0.113.7, 10.0.0.1", "10.0.0.9", 2), "203.0.113.7");
  check("a header shorter than the configured chain falls back to the socket", callerAddressOf("203.0.113.7", "10.0.0.9", 2), "10.0.0.9");
  check("and so does no header at all", callerAddressOf(undefined, "10.0.0.9", 1), "10.0.0.9");
  check("an empty forwarded header falls through rather than winning", callerAddressOf("", "10.0.0.9", 1), "10.0.0.9");
  // Node reports an IPv4 client on a dual-stack listener as IPv4-mapped IPv6.
  check("an IPv4-mapped IPv6 address is unmapped", callerAddressOf(undefined, "::ffff:192.168.1.4"), "192.168.1.4");
  check("a real IPv6 address is left alone", callerAddressOf(undefined, "2001:db8::1"), "2001:db8::1");
  check("neither is 'unknown' rather than empty", callerAddressOf(undefined, undefined), "unknown");
  report(
    "and an over-long forwarded header is clamped",
    callerAddressOf("x".repeat(500), undefined, 1).length === 64,
    `${callerAddressOf("x".repeat(500), undefined, 1).length} chars`,
  );
  // With zero hops behind a real proxy every counter keys on the proxy, so main.ts warns once.
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
  // Asserted against the database: the route maps a missing join to null, so its response agrees with itself.
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

  db.prepare("DELETE FROM user_session_origins WHERE session_id = (SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1)").run(made.id);
  const afterForget = (await (await send("/v1/me/sessions", { headers: bearer(described.token) })).json()) as {
    sessions: Array<{ current: boolean; ip: string | null; userAgent: string | null }>;
  };
  check("a session with no origin row is still listed", afterForget.sessions.find((row) => row.current)?.ip, null);

  const longAgent = (await (await post("/v1/login", { name: "ada", password: made.password }, { "content-type": "application/json", "user-agent": "Z".repeat(4000) })).json()) as { token: string };
  const clamped = (await (await send("/v1/me/sessions", { headers: bearer(longAgent.token) })).json()) as {
    sessions: Array<{ current: boolean; userAgent: string | null }>;
  };
  check("an over-long user agent is clamped at ingest", clamped.sessions.find((row) => row.current)?.userAgent?.length, 256);

  // foreign_keys is OFF, so nothing cascades and the sweep is ours.
  db.prepare("INSERT INTO user_session_origins (session_id, ip, user_agent) VALUES ('s_orphan', '1.2.3.4', 'x')").run();
  pruneSessions(db);
  check("pruning collects origins whose session is gone", db.prepare("SELECT COUNT(*) AS n FROM user_session_origins WHERE session_id = 's_orphan'").get()?.["n"], 0);

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
    check("their password is gone", db.prepare("SELECT user_id FROM user_passwords WHERE user_id = ?").get(doomed.id), undefined);
    check("their API key is gone", db.prepare("SELECT id FROM api_keys WHERE user_id = ?").get(doomed.id), undefined);
    check("their sessions are gone", db.prepare("SELECT id FROM user_sessions WHERE user_id = ?").get(doomed.id), undefined);
    check("their grants are gone", db.prepare("SELECT user_id FROM grants WHERE user_id = ?").get(doomed.id), undefined);
    check("and their ownership is released", db.prepare("SELECT machine_id FROM machine_owners WHERE user_id = ?").get(doomed.id), undefined);
    // Revoked, not left ownerless: an ownerless machine has no limit and no ban check.
    const leaver = db.prepare("SELECT revoked_at FROM machines WHERE id = 'm_leaver'").get();
    report("the machine row survives, for the audit trail", leaver !== undefined, "m_leaver still listed");
    check("but it is revoked rather than left ownerless", leaver?.["revoked_at"] !== null, true);
    // Scoped to m_leaver: the relay sections build ownerless machines by hand on purpose.
    check(
      "the deleted user left nothing live and ownerless behind",
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM machines WHERE id = 'm_leaver' AND revoked_at IS NULL",
        )
        .get()?.["n"],
      0,
    );
    // callerAuth joins users, so a credential whose subject is gone fails closed anyway.
    check("their session no longer authenticates", (await send("/v1/me", { headers: bearer(theirSession.token) })).status, 401);
    check("nor does their API key", (await send("/v1/me", { headers: bearer(doomed.apiKey) })).status, 401);
    check("and signing in as them is refused", (await outcome(await login("leaver", doomed.password)))[0], 401);
    check("the name can be used again", (await post("/v1/admin/users", { name: "leaver" }, admin)).status, 201);
  }

  const laptop = (await (await login("ada", made.password)).json()) as { token: string };
  const tablet = (await (await login("ada", made.password)).json()) as { token: string };
  check("changing a password needs the current one", await outcome(await post("/v1/me/password", { newPassword: "a-fine-new-password" }, bearer(laptop.token))), [400, "bad_request"]);
  check("a wrong current password is refused", await outcome(await post("/v1/me/password", { currentPassword: "nope", newPassword: "a-fine-new-password" }, bearer(laptop.token))), [401, "invalid_password"]);
  check("a short new one is refused with a reason", await outcome(await post("/v1/me/password", { currentPassword: made.password, newPassword: "short" }, bearer(laptop.token))), [400, "weak_password"]);

  // Compared before and after, not to a literal: ada already replaced her password once above.
  const changedBefore = ((await (await send("/v1/me", { headers: bearer(laptop.token) })).json()) as { passwordChangedAt?: number | null }).passwordChangedAt;
  const changeAt = Date.now();
  check("the change lands", (await post("/v1/me/password", { currentPassword: made.password, newPassword: "a-fine-new-password" }, bearer(laptop.token))).status, 200);
  {
    const changedAfter = ((await (await send("/v1/me", { headers: bearer(laptop.token) })).json()) as { passwordChangedAt?: number | null }).passwordChangedAt;
    check("/v1/me says when the password was changed", [
      typeof changedAfter === "number" && changedAfter >= changeAt,
      typeof changedAfter === "number" && (changedBefore === null || changedBefore === undefined || changedAfter > changedBefore),
    ], [true, true]);
  }
  check("the tab that made it stays signed in", (await send("/v1/me", { headers: bearer(laptop.token) })).status, 200);
  check("every other device is signed out", await outcome(await send("/v1/me", { headers: bearer(tablet.token) })), [401, "session_revoked"]);
  check("the old password stops working", (await login("ada", made.password)).status, 401);
  check("and the new one works", (await login("ada", "a-fine-new-password")).status, 200);

  // hashCredential trims; password.ts must never trim.
  await post("/v1/me/password", { currentPassword: "a-fine-new-password", newPassword: "trailing space  " }, bearer(laptop.token));
  check("a trailing space is part of the password", (await login("ada", "trailing space  ")).status, 200);
  check("and the trimmed form is not the password", (await login("ada", "trailing space")).status, 401);

  const legacyKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_old', 'oldtimer', 0, ?)").run(now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_old', ?, ?, ?)").run(
    newId("ak"),
    legacyKey.prefix,
    legacyKey.hash,
    now,
  );
  const legacy = { authorization: `Bearer ${legacyKey.key}`, "content-type": "application/json" };
  check(
    "a row that never chose a password answers null for when it did",
    ((await (await send("/v1/me", { headers: legacy })).json()) as { passwordChangedAt?: number | null }).passwordChangedAt,
    null,
  );
  check("a user with no password sets a first one with their key alone", (await post("/v1/me/password", { newPassword: "an-entirely-new-password" }, legacy)).status, 200);
  check(
    "and setting a first one counts as choosing it",
    typeof ((await (await send("/v1/me", { headers: legacy })).json()) as { passwordChangedAt?: number | null }).passwordChangedAt,
    "number",
  );
  check("and then the current one is required", await outcome(await post("/v1/me/password", { newPassword: "another-new-password" }, legacy)), [400, "bad_request"]);
  check("they can now sign in", (await login("oldtimer", "an-entirely-new-password")).status, 200);

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

  const ada = bearer(((await (await login("ada", adaPassword)).json()) as { token: string }).token);
  db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(withKey.id);
  const bobSession = bearer(((await (await login("bob", withKey.password)).json()) as { token: string }).token);
  const bobMinted = (await (await post(
    "/v1/me/keys",
    {},
    { ...bobSession, "content-type": "application/json" },
  )).json()) as { apiKey: string };
  check("and with it, a key that looks like every other one here", bobMinted.apiKey.slice(0, 3), "rk_");
  const bobKey = { authorization: `Bearer ${bobMinted.apiKey}`, "content-type": "application/json" };

  {
    // last_used_at is written at most once a minute per key; the minute is crossed by aging the stored value.
    const bobKeys = async (): Promise<{ id: string; prefix: string; revokedAt: number | null; lastUsedAt: number | null }[]> =>
      ((await (await send("/v1/me/keys", { headers: bobSession })).json()) as {
        keys: { id: string; prefix: string; revokedAt: number | null; lastUsedAt: number | null }[];
      }).keys;
    const minted = (await bobKeys()).find((key) => key.prefix === bobMinted.apiKey.slice(3, 11));
    check("a freshly minted key has never been used", minted?.lastUsedAt, null);
    const storedUse = (): number | null => {
      const value = db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(minted?.id ?? "")?.["last_used_at"];
      return value === null || value === undefined ? null : Number(value);
    };

    const firstUse = Date.now();
    check("using it authenticates", (await send("/v1/me", { headers: bobKey })).status, 200);
    const afterFirst = storedUse();
    check("and the first use is written", afterFirst !== null && afterFirst >= firstUse, true);
    check("a second use inside the minute writes nothing", [(await send("/v1/me", { headers: bobKey })).status, storedUse()], [200, afterFirst]);
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run((afterFirst ?? 0) - KEY_TOUCH_INTERVAL_MS - 1, minted?.id ?? "");
    const aged = storedUse();
    check("a use past the minute writes again", [(await send("/v1/me", { headers: bobKey })).status, (storedUse() ?? 0) > (aged ?? 0)], [200, true]);
    // Only the key's holder is told when it was last used (Q1.631).
    check("the keys list answers it", typeof (await bobKeys()).find((key) => key.id === minted?.id)?.lastUsedAt, "number");
    check(
      "and the admin's view of the same list no longer exists",
      (await send(`/v1/admin/users/${withKey.id}/keys`, { headers: admin })).status,
      404,
    );

    // On a second key so bobKey survives; a marker no request could write proves nothing moved it.
    const spare = (await (await post(
      "/v1/me/keys",
      { currentPassword: withKey.password },
      bobSession,
    )).json()) as { apiKey: string };
    const spareRow = (await bobKeys()).find((key) => key.prefix === spare.apiKey.slice(3, 11));
    const spareBearer = { authorization: `Bearer ${spare.apiKey}` };
    check("the spare key works before it is revoked", (await send("/v1/me", { headers: spareBearer })).status, 200);
    check("revoking it lands", (await send(`/v1/me/keys/${spareRow?.id ?? ""}`, { method: "DELETE", headers: bobSession })).status, 200);
    const marker = 1_000_000;
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(marker, spareRow?.id ?? "");
    check("a revoked key is refused", await outcome(await send("/v1/me", { headers: spareBearer })), [401, "api_key_revoked"]);
    check(
      "and its last use does not move",
      Number(db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(spareRow?.id ?? "")?.["last_used_at"]),
      marker,
    );
  }

  {
    // touchKey's write must sit in a try: past BUSY_TIMEOUT_MS it throws and nothing reads last_used_at for a decision.
    // Read off the source, since no in-memory database can be made busy from another process.
    const appSource = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
    const touches = "touchKey.run(";
    check("app.ts touches a key's last use in exactly one place", appSource.split(touches).length - 1, 1);
    check(
      "and that place is the body of a try whose catch swallows the failure",
      /try \{\s*touchKey\.run\([^;]{0,200};\s*\} catch \{/.test(appSource),
      true,
    );
  }

  {
    // An old file opens and reads null: the columns arrive by ADD COLUMN, so CP_SCHEMA_VERSION need not move.
    const old = new DatabaseSync(":memory:");
    old.exec(
      "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, disabled_at INTEGER);" +
        "CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);",
    );
    const oldKey = newApiKey();
    old.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_before', 'before', 0, ?)").run(now);
    old.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES ('ak_before', 'u_before', ?, ?, ?)").run(
      oldKey.prefix,
      oldKey.hash,
      now,
    );
    applyControlPlaneSchema(old);
    applyControlPlaneSchema(old);
    const columnNames = (table: string): string[] =>
      old.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column["name"]));
    check("migrating an old file adds both columns, and twice is harmless", [
      columnNames("users").includes("password_changed_at"),
      columnNames("api_keys").includes("last_used_at"),
    ], [true, true]);
    check(
      "and the rows that were there read null in both",
      [
        old.prepare("SELECT password_changed_at AS v FROM users WHERE id = 'u_before'").get()?.["v"],
        old.prepare("SELECT last_used_at AS v FROM api_keys WHERE id = 'ak_before'").get()?.["v"],
      ],
      [null, null],
    );
    ensureSigningKey(old);
    const before = createControlPlaneApp({ db: old, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const oldBearer = { authorization: `Bearer ${oldKey.key}` };
    check(
      "a row from before the column answers null for its password",
      ((await (await before.request("/v1/me", { headers: oldBearer })).json()) as { passwordChangedAt?: number | null }).passwordChangedAt,
      null,
    );
    check(
      "and its key's first use after the upgrade is the upgrade's first request",
      typeof ((await (await before.request("/v1/me/keys", { headers: oldBearer })).json()) as { keys: { lastUsedAt: number | null }[] }).keys[0]?.lastUsedAt,
      "number",
    );
    old.close();
  }

  const mine = (await (await post("/v1/machines", { name: "laptop" }, ada)).json()) as {
    machine: { id: string; scopes: string[] };
    enrollment: { code: string };
  };
  check("a user creates their own machine", typeof mine.machine.id, "string");
  // All three scopes: machine:admin guards workspace removal on the daemon.
  check("and holds every scope on it", [...mine.machine.scopes].sort(), ["machine:admin", "session:read", "session:write"]);
  check("without an admin granting anything", ((await (await send("/v1/machines", { headers: ada })).json()) as { machines: { id: string }[] }).machines.some((m) => m.id === mine.machine.id), true);

  check("somebody else may call one 'laptop' too", (await post("/v1/machines", { name: "laptop" }, bobKey)).status, 201);
  check("but the same person may not, twice", await outcome(await post("/v1/machines", { name: "laptop" }, ada)), [409, "machine_exists"]);
  // Wider than the unique index: shared and legacy machines appear in your list under machines.name too.
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
  const adaSees = ((await (await send("/v1/machines", { headers: ada })).json()) as {
    machines: { id: string; name: string; owned?: boolean }[];
  }).machines.find((m) => m.id === mine.machine.id);
  check("each owner sees their own label", adaSees?.name, "laptop");
  check("and is told it is theirs to manage", adaSees?.owned, true);
  check("a token can be minted by the label alone", (await outcome(await post("/v1/tokens", { machine: "laptop" }, ada)))[1], "machine_not_enrolled");

  check("somebody else's machine is a 404, not a 403", await outcome(await send(`/v1/machines/${mine.machine.id}`, { method: "PATCH", headers: bobKey, body: JSON.stringify({ name: "stolen" }) })), [404, "machine_not_found"]);
  check("and so is minting a code for it", await outcome(await post(`/v1/machines/${mine.machine.id}/enrollments`, {}, bobKey)), [404, "machine_not_found"]);
  check("and revoking it", await outcome(await post(`/v1/machines/${mine.machine.id}/revoke`, {}, bobKey)), [404, "machine_not_found"]);
  check("a machine nobody owns is not user-manageable", await outcome(await send(`/v1/machines/${mine.machine.id === "m_mine" ? "m_other" : "m_mine"}`, { method: "PATCH", headers: ada, body: JSON.stringify({ name: "x" }) })), [404, "machine_not_found"]);

  const second = (await (await post(`/v1/machines/${mine.machine.id}/enrollments`, {}, ada)).json()) as { code: string };
  const redeem = (code: string): Promise<Response> =>
    post("/v1/enroll", { code }, { "content-type": "application/json" });
  check("minting a code burns the one before it", (await outcome(await redeem(mine.enrollment.code)))[1], "code_unusable");
  check("and the newest redeems", (await redeem(second.code)).status, 200);
  check("a code cannot be redeemed twice", (await outcome(await redeem(second.code)))[1], "code_unusable");

  {
    // Its own app: the throttle is per instance and the logins above would have armed it.
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
    check("the right password is refused while blocked", (await attempt("ada", adaPassword)).status, 429);
    // Keyed on name and address, so a 429 reveals nothing about whether the account exists.
    check("a different name is unaffected", (await attempt("someone-else", "wrong-wrong-wrong")).status, 401);
  }

  {
    const started = Date.now();
    await login("ada", "wrong-again-wrong");
    const elapsed = Date.now() - started;
    // A generous ceiling, not a measurement: catches N raised far enough to time out a sign-in.
    report("hashing a password costs a bounded amount of time", elapsed < 2000, `${elapsed}ms`);
  }
}

process.stdout.write("\nthe login throttle\n");
{
  // A fixed clock, so nothing here waits and nothing is probabilistic.
  const T0 = 1_800_000_000_000;
  const addressA = "198.51.100.4";
  const addressB = "203.0.113.9";

  check("a key folds case", loginKey("Ada", addressA), loginKey("ada", addressA));
  {
    const throttle = new LoginThrottle();
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(loginKey("Ada", addressA), T0);
    check("so blocking `Ada` blocks `ada`", throttle.check(loginKey("ada", addressA), T0).allowed, false);
    check("a login block does not follow the name to another address", throttle.check(loginKey("ada", addressB), T0).allowed, true);
    check("and cannot reach a password change at all", throttle.check(passwordChangeKey("u_ada"), T0).allowed, true);
  }
  // One account named two ways spends two counters, by choice; addressKey bounds the doubling.
  {
    const throttle = new LoginThrottle();
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(loginKey("ada", addressA), T0);
    check("guessing at a name does not block that person's address", throttle.check(loginKey("ada@example.com", addressA), T0).allowed, true);
  }
  // The address half must survive an identifier as long as a real address (MAX_EMAIL_KEY_CHARS).
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
  // The namespace matters because the address half is caller-supplied.
  check("an anonymous caller cannot spell a password-change key", loginKey("pwchg", "u_deadbeef") === passwordChangeKey("u_deadbeef"), false);
  check("and the halves cannot be re-cut", loginKey("a|b", "c") === loginKey("a", "b|c"), false);

  const blockSeconds = (failures: number): number => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < failures; i += 1) throttle.fail("one-key", T0);
    return throttle.check("one-key", T0).retryAfterSeconds;
  };
  // Nothing until the threshold, then doubling, then the ceiling; 0 means allowed.
  check(
    "the block doubles past the threshold and then stops",
    [5, 6, 7, 8, 9, 10, 11, 12].map(blockSeconds),
    [0, 30, 60, 120, 240, 480, 900, 900],
  );
  check("the ceiling is the documented one", blockSeconds(40), DEFAULT_THROTTLE.maxBlockMs / 1000);
  // An unclamped exponent is Infinity, which JSON writes as null: a wait for ever.
  check("and a long attack is still a number", blockSeconds(2_000), DEFAULT_THROTTLE.maxBlockMs / 1000);

  {
    const throttle = new LoginThrottle();
    const key = loginKey("ada", addressA);
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(key, T0);
    check("blocked", throttle.check(key, T0).allowed, false);
    throttle.fail(key, T0 + DEFAULT_THROTTLE.windowMs + 1);
    check("an elapsed window starts again", throttle.check(key, T0 + DEFAULT_THROTTLE.windowMs + 1).allowed, true);
  }
  {
    const throttle = new LoginThrottle();
    const key = loginKey("ada", addressA);
    for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(key, T0);
    throttle.succeed(key);
    // succeed also un-records the optimistic failure the route writes before it awaits.
    check("a success forgets the failures", throttle.check(key, T0).allowed, true);
  }

  {
    // Keyed by a caller-chosen string, so the table must be capped.
    const throttle = new LoginThrottle({ maxEntries: 8 });
    for (let i = 0; i < 9; i += 1) throttle.fail(loginKey(`name-${i}`, addressA), T0);
    report(
      "a table past its cap is swept rather than grown",
      throttle.size() <= 8,
      // Zero on purpose: nothing has settled at one instant, so enforceCap clears outright.
      `${throttle.size()} keys held after 9 distinct ones`,
    );
  }

  // Looser on purpose: everybody behind one NAT shares this key.
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
    check("and thirty-one are", spray.check(key, T0).allowed, false);
  }

  // A success may not erase a crowd's counter: forgive removes one attempt, succeed deletes the entry.
  {
    const spray = new LoginThrottle(ADDRESS_THROTTLE);
    const key = addressKey(addressA);
    for (let i = 0; i < ADDRESS_THROTTLE.threshold; i += 1) spray.fail(key, T0);
    spray.forgive(key);
    spray.fail(key, T0);
    spray.fail(key, T0);
    check("a success forgives one attempt, not the crowd's history", spray.check(key, T0).allowed, false);

    const own = new LoginThrottle(ADDRESS_THROTTLE);
    const mine = addressKey(addressA);
    for (let i = 0; i < ADDRESS_THROTTLE.threshold + 5; i += 1) {
      own.fail(mine, T0);
      own.forgive(mine);
    }
    check("but a run of real sign-ins never blocks the address they share", own.check(mine, T0).allowed, true);
  }

  // No argument may make any two builders write the same string; a new builder is covered by adding it here.
  {
    const builders: { name: string; of: (value: string) => string }[] = [
      // Two-argument builders get the same string twice, the arrangement most likely to collide.
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
      // Without PROVISION_NS a provisioning attempt would share addressKey's counter; only this list catches that.
      { name: "provisionKey", of: provisionKey },
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

    const exported = Object.entries(await import("../packages/control-plane/src/throttle.js"))
      .filter(([name, value]) => typeof value === "function" && name.endsWith("Key"))
      .map(([name]) => name)
      .sort();
    check("every exported key builder is in this list", builders.map((builder) => builder.name).sort(), exported);

    // Past every field cap, so each builder writes its longest key; normalize cutting one merges two counters.
    const overlong = "x".repeat(MAX_KEY_CHARS + 1);
    check(
      "no builder's longest key is longer than the throttle keeps",
      builders.filter((builder) => builder.of(overlong).length > MAX_KEY_CHARS).map((builder) => builder.name),
      [],
    );
    {
      const throttle = new LoginThrottle();
      const tail = (end: string): string => `${"f".repeat(MAX_ADDRESS_CHARS - 1)}${end}`;
      for (let i = 0; i <= DEFAULT_THROTTLE.threshold; i += 1) throttle.fail(loginKey(overlong, tail("1")), T0);
      check(
        "the longest identifier from the longest address still keeps the address's last character",
        throttle.check(loginKey(overlong, tail("2")), T0).allowed,
        true,
      );
    }
  }

  // Recipient keys follow the victim; mail and reset mail are split so a registration flood cannot block recovery.
  check("mail is bounded per address, whatever case it was typed in", mailKey("A@B"), mailKey("a@b"));
  check("and reset mail is counted somewhere else entirely", mailKey("a@b") === resetMailKey("a@b"), false);

  // A long address must not fold into another's counter (MAX_EMAIL_KEY_CHARS); these differ only past character 200.
  {
    const stem = "a".repeat(240);
    const long = `${stem}1@example.com`;
    const alsoLong = `${stem}2@example.com`;
    check("two addresses differing past 200 characters are two counters", mailKey(long) === mailKey(alsoLong), false);
    check("and the same holds for the reset budget", resetMailKey(long) === resetMailKey(alsoLong), false);
    report(
      "while a composed key is still bounded",
      mailKey(long).length <= MAX_KEY_CHARS,
      `${mailKey(long).length} chars`,
    );
  }

  check("two routes on one account are two budgets", writeKey("u_1", "token") === writeKey("u_1", "enroll"), false);
  check("and two accounts on one route are two more", writeKey("u_1", "token") === writeKey("u_2", "token"), false);
}

process.stdout.write("\na password, as a function\n");
{

  check("a password may not be the user name", checkPasswordPolicy("ada-lovelace", "ada-lovelace") === null, false);
  check("and case does not dodge that", checkPasswordPolicy("ADA-LOVELACE", "ada-lovelace") === null, false);
  check("nor does the surrounding space the name is compared without", checkPasswordPolicy("ada-lovelace", "  Ada-Lovelace  ") === null, false);
  check("a short one is refused", checkPasswordPolicy("short", "grace") === null, false);
  // The maximum bounds what is normalized and stored, not KDF cost; asserted on both sides of the boundary.
  check("the longest allowed is allowed", checkPasswordPolicy("x".repeat(PASSWORD_MAX_LENGTH), "grace"), null);
  check("and one more is not", checkPasswordPolicy("x".repeat(PASSWORD_MAX_LENGTH + 1), "grace") === null, false);
  check("a non-string is refused rather than coerced", checkPasswordPolicy(12345678901234, "grace"), "password must be a string");

  // Escapes, not literal characters: an editor normalizing on save would make the two strings identical.
  // Annotated string: as literal types tsc rejects the comparison (TS2367).
  const decomposed: string = "cafe\u0301-passphrase";
  const precomposed: string = "caf\u00e9-passphrase";
  check("the two spellings really are different bytes", decomposed === precomposed, false);
  check("and normalize to one", normalizePassword(decomposed), normalizePassword(precomposed));
  check("so a hash written from one verifies the other", (await verifyPassword(precomposed, await hashPassword(decomposed, "authenticated"), "authenticated")).ok, true);
  check("normalizing does not trim", normalizePassword("  spaced  "), "  spaced  ");

  // A corrupt row must be a refusal: a throw would be a 500 on the login path.
  const corrupt = [
    "",
    "not-a-hash",
    "scrypt$32768$8$1$onlyfiveparts",
    // N below the floor and above what MAX_MEM allows: bounded in decode, since scrypt would throw.
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

  // Parameters are read from the row, so raising N rehashes gradually; written by hand since hashPassword writes only the current ones.
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

  // Only POST /v1/login rewrites a row, best-effort in a try, so a regression here fails silently.
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
  check("and the same password still works against it", (await signIn()).status, 200);
}

// Route-level because each case is about concurrency; one app per case, since a throttle is per instance.

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

  {
    // spendWrite runs before the lookup, so a request that then fails still spends the budget.
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

  {
    // fail is recorded before the verifyPassword await, so concurrent guesses are counted.
    // The request that trips the block passed check before its own fail, hence threshold + 1.
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
    const blocked = attempts.find((response) => response.status === 429);
    check("the refusal carries a code and a wait", [
      ((await blocked?.clone().json()) as { error?: { code?: string } } | undefined)?.error?.code ?? "none",
      Number(blocked?.headers.get("retry-after") ?? 0) > 0,
    ], ["too_many_attempts", true]);
  }

  {
    // Concurrent creates of one name race the UNIQUE index across the scrypt await; the loser must still answer the JSON envelope.
    const envelopeCode = async (response: Response | undefined): Promise<string> => {
      if (response === undefined) return "(no response)";
      const text = await response.clone().text();
      try {
        return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "(no error key)";
      } catch {
        // Not JSON is the defect itself, so report the body.
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
      // A delta: other sections write to that table too.
      passwordRows() - held,
    ], [1, 1]);
    // The ROLLBACK before the 409 keeps the shared connection usable for the next writer.
    check("and the next create is unaffected", (await root.post("/v1/admin/users", { name: "sagan" }, admin)).status, 201);
  }

  {
    // Proxied, since distinct addresses are the subject and an unproxied app sees only one.
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
    // The remedy must survive the attack: passwordChangeKey is namespaced on the user id.
    const changed = await on(fresh).post(
      "/v1/me/password",
      { currentPassword: grace.password, newPassword: "a-brand-new-password" },
      json({ authorization: `Bearer ${session.token}`, "x-forwarded-for": attacker }),
    );
    check("and changes her password while it is still happening", changed.status, 200);
  }

  {
    // Unproxied, the header is caller-typed: forty rotated addresses must still meet the one socket counter.
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

  {
    // An unknown name still verifies against the decoy, so distinct names and addresses reach the KDF; the lane split is for this.
    const fresh = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const spray = Array.from({ length: 40 }, (_, i) =>
      on(fresh).post(
        "/v1/login",
        { name: `ghost-${i}`, password: "not-a-password-either" },
        json({ "x-forwarded-for": `10.0.${Math.floor(i / 250)}.${i % 250}` }),
      ),
    );
    // This route because it hashes in the authenticated lane; /v1/me/keys takes no lane slot and would pass vacuously.
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
    check("and an authenticated hash still completes through it", (await reset).status, 200);
  }
}

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

  const T0 = Date.now();
  // By id, not by counting: this user holds several sessions by the end.
  const listedAt = (userId: string, sessionId: string, at: number): boolean =>
    listSessions(db, userId, at).some((row) => row.id === sessionId);
  {
    const absolute = mintSession(db, sleeper, anonymous, null, T0);
    // last_seen_at moved forward so only the absolute arm can fire.
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?").run(T0 + SESSION_TTL_MS, absolute.id);
    check("a session resolves while it is live", resolveSession(db, absolute.token, T0), {
      ok: true,
      // deviceId null rather than absent: callerAuth copies it onto Caller.
      session: { id: absolute.id, userId: sleeper, deviceId: null },
    });
    check("and is expired past its absolute TTL", resolveSession(db, absolute.token, T0 + SESSION_TTL_MS + 1), {
      ok: false,
      reason: "expired",
    });
    check("the listing drops it too", [listedAt(sleeper, absolute.id, T0), listedAt(sleeper, absolute.id, T0 + SESSION_TTL_MS + 1)], [true, false]);
  }
  {
    const idle = mintSession(db, sleeper, anonymous, null, T0);
    // listSessions filters the idle window in JavaScript, not SQL.
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

  {
    const stale = mintSession(db, sleeper, anonymous, null);
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, stale.id);
    check("an expired session is a 401 the client can act on", await outcome(await send("/v1/me", { headers: bearer(stale.token) })), [401, "session_expired"]);
  }
  {
    const forgotten = mintSession(db, sleeper, anonymous, null);
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?").run(Date.now() - SESSION_IDLE_MS - 1, forgotten.id);
    check("and so is one nobody has used for a fortnight", await outcome(await send("/v1/me", { headers: bearer(forgotten.token) })), [401, "session_expired"]);
  }
  check("a token this service never minted is not either of those", await outcome(await send("/v1/me", { headers: bearer("rs_" + "x".repeat(43)) })), [401, "invalid_api_key"]);

  {
    const crowded = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'crowded', 0, ?)").run(crowded, now);
    // Each mint gets its own timestamp, so ORDER BY created_at has no ties.
    const tokens = Array.from({ length: MAX_SESSIONS_PER_USER + 2 }, (_, i) => mintSession(db, crowded, anonymous, null, T0 + i));
    const live = Number(
      db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL").get(crowded)?.["n"] ?? 0,
    );
    check("exactly the cap survives", live, MAX_SESSIONS_PER_USER);
    check("and the listing agrees", listSessions(db, crowded, T0 + MAX_SESSIONS_PER_USER + 2).length, MAX_SESSIONS_PER_USER);
    // The oldest go: a new device must never be refused because of an old one.
    check("the two oldest are the ones retired", [
      resolveSession(db, tokens[0]?.token ?? "", T0).ok,
      resolveSession(db, tokens[1]?.token ?? "", T0).ok,
      resolveSession(db, tokens[2]?.token ?? "", T0).ok,
    ], [false, false, true]);
    check("and the newest still reaches /v1/me", (await send("/v1/me", { headers: bearer(tokens[tokens.length - 1]?.token ?? "") })).status, 200);
  }

  {
    // Without the guard this is an fsync per request on the relay's process.
    const touched = mintSession(db, sleeper, anonymous, null, T0);
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

  {
    const holder = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'holder', 0, ?)").run(holder, now);
    const first = mintSession(db, holder, anonymous, null);
    const second = mintSession(db, holder, anonymous, null);
    const third = mintSession(db, holder, anonymous, null);

    const one = (await (await send(`/v1/me/sessions/${second.id}`, { method: "DELETE", headers: bearer(first.token) })).json()) as Record<string, unknown>;
    check("signing one device out answers a boolean", one, { revoked: true });
    const current = (await (await send("/v1/me/sessions/current", { method: "DELETE", headers: bearer(third.token) })).json()) as Record<string, unknown>;
    check("and so does signing this one out", current, { revoked: true });

    // The count is revokedCount so that revoked is always the boolean.
    const all = (await (await send("/v1/me/sessions", { method: "DELETE", headers: bearer(first.token) })).json()) as Record<string, unknown>;
    check("signing out everywhere answers a count", all, { revokedCount: 1 });
    check("and does not also answer under the boolean's name", "revoked" in all, false);
  }
}

// Session revocation must still bite with a live device joined; a retired id on login registers a fresh device.
// Another account's device id is ignored on login and 404s on delete; the cap refuses rather than evicting.

process.stdout.write("\ndevices, and retiring one\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
  const bearer = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];

  // Signs in through POST /v1/login, the only route that binds a device at mint.
  const PASSWORD = "device-section-password";
  const hash = await hashPassword(PASSWORD, "authenticated");
  const signUp = (name: string): string => {
    const id = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(id, name, now);
    db.prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?, ?, ?)").run(id, hash, now);
    return id;
  };
  const signIn = async (
    name: string,
    device?: { id?: string; name: string; platform: string; publicKey?: string },
  ): Promise<Record<string, unknown>> =>
    json(
      await send("/v1/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(device === undefined ? { name, password: PASSWORD } : { name, password: PASSWORD, device }),
      }),
    );

  const rina = signUp("rina-devices");

  const macbook = await signIn("rina-devices", { name: "MacBook Pro", platform: "macos" });
  check("signing in with a device answers the id it bound", typeof macbook["deviceId"], "string");
  const macbookId = String(macbook["deviceId"]);
  const macbookToken = String(macbook["token"]);

  const iphone = await signIn("rina-devices", { name: "iPhone", platform: "ios" });
  const iphoneId = String(iphone["deviceId"]);
  const iphoneToken = String(iphone["token"]);
  check("a second sign-in from a different installation is a different device", macbookId !== iphoneId, true);

  const listed = async (token: string): Promise<{ id: string; name: string; platform: string; revokedAt: number | null; current: boolean }[]> => {
    const body = await json(await send("/v1/me/devices", { headers: bearer(token) }));
    return body["devices"] as { id: string; name: string; platform: string; revokedAt: number | null; current: boolean }[];
  };
  check(
    "both are listed, newest first",
    (await listed(macbookToken)).map((row) => row.name),
    ["iPhone", "MacBook Pro"],
  );
  check(
    "and the row this request came through says so",
    (await listed(macbookToken)).filter((row) => row.current).map((row) => row.name),
    ["MacBook Pro"],
  );

  // The app re-presents its id on every start, so adoption must not grow the list.
  const again = await signIn("rina-devices", { id: macbookId, name: "MacBook Pro", platform: "macos" });
  check("offering an id already held adopts it rather than registering again", again["deviceId"], macbookId);
  check("so the list has not grown", (await listed(macbookToken)).length, 2);

  const bare = await signIn("rina-devices");
  check("a sign-in naming no device binds none", bare["deviceId"], null);
  check("and still works", typeof bare["token"], "string");
  check("and did not invent a row", (await listed(macbookToken)).length, 2);

  const revoked = await json(await send(`/v1/me/devices/${iphoneId}`, { method: "DELETE", headers: bearer(macbookToken) }));
  check("retiring one device answers what it ended", revoked, { revoked: true, sessionsRevoked: 1 });
  check(
    "⭐ the other device's session is untouched",
    (await send("/v1/me", { headers: bearer(macbookToken) })).status,
    200,
  );
  check(
    "and the retired one's session is refused, by its own code",
    await outcome(await send("/v1/me", { headers: bearer(iphoneToken) })),
    [401, "device_revoked"],
  );
  check(
    "a retired device is still listed, with the date it was retired",
    (await listed(macbookToken)).filter((row) => row.id === iphoneId).map((row) => row.revokedAt !== null),
    [true],
  );

  {
    // Folding the device check into resolveSession's query as a join makes revoked_at the device's; only this notices.
    const live = await signIn("rina-devices", { name: "Desk", platform: "linux" });
    const token = String(live["token"]);
    check("a session on a live device resolves", (await send("/v1/me", { headers: bearer(token) })).status, 200);
    revokeSession(db, String(live["sessionId"]));
    check(
      "⭐ and session revocation still bites on it — the join that would break this is why there are two statements",
      await outcome(await send("/v1/me", { headers: bearer(token) })),
      [401, "session_revoked"],
    );
    check(
      "while its device is untouched, because a session is not the installation",
      (await listed(macbookToken)).filter((row) => row.name === "Desk").map((row) => row.revokedAt),
      [null],
    );
  }

  {
    const reused = await signIn("rina-devices", { id: iphoneId, name: "iPhone", platform: "ios" });
    check("signing in with a retired id is not refused", typeof reused["token"], "string");
    check("⭐ and it registers a fresh device rather than binding the dead one", reused["deviceId"] !== iphoneId, true);
    check(
      "so the next request works, which is the loop not happening",
      (await send("/v1/me", { headers: bearer(String(reused["token"])) })).status,
      200,
    );
    check(
      "and the retired row stays retired",
      (await listed(macbookToken)).filter((row) => row.id === iphoneId).map((row) => row.revokedAt !== null),
      [true],
    );
  }

  {
    signUp("mallory-devices");
    const mallory = await signIn("mallory-devices", { name: "Mallory's box", platform: "linux" });
    const malloryToken = String(mallory["token"]);

    const bound = await signIn("mallory-devices", { id: macbookId, name: "Mallory's box", platform: "linux" });
    check("⭐ naming another account's device id binds a fresh row instead", bound["deviceId"] !== macbookId, true);
    check(
      "so the victim's device still belongs to the victim",
      (await listed(macbookToken)).some((row) => row.id === macbookId),
      true,
    );
    check(
      "⭐ and deleting another account's device is the same 404 as one that does not exist",
      await outcome(await send(`/v1/me/devices/${macbookId}`, { method: "DELETE", headers: bearer(malloryToken) })),
      await outcome(await send("/v1/me/devices/dv_000000000000000", { method: "DELETE", headers: bearer(malloryToken) })),
    );
    check(
      "which leaves it working",
      (await send("/v1/me", { headers: bearer(macbookToken) })).status,
      200,
    );
  }

  {
    const key = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      rina,
      key.prefix,
      key.hash,
      now,
    );
    check(
      "an API key cannot register a device, because it has no session to bind one to",
      await outcome(
        await send("/v1/me/devices", {
          method: "POST",
          headers: bearer(key.key),
          body: JSON.stringify({ name: "cpctl", platform: "linux" }),
        }),
      ),
      [409, "device_needs_session"],
    );
    check(
      "and it can still read the list, which is how somebody finds out",
      (await send("/v1/me/devices", { headers: bearer(key.key) })).status,
      200,
    );
  }

  {
    const long = await signIn("rina-devices", { name: "n".repeat(4000), platform: "p".repeat(400) });
    const row = (await listed(macbookToken)).find((entry) => entry.id === String(long["deviceId"]));
    // Row found first, then lengths as equalities: the fixture sends more than either ceiling.
    check("the long-named device is in the list at all", row !== undefined, true);
    check("a caller-supplied name is clamped where it enters the database", row?.name.length, MAX_DEVICE_NAME_CHARS);
    check("and so is the platform it came with", row?.platform.length, MAX_DEVICE_PLATFORM_CHARS);
    void (await send(`/v1/me/devices/${String(long["deviceId"])}`, { method: "DELETE", headers: bearer(macbookToken) }));
  }

  {
    const capped = signUp("capped-devices");
    const session = await signIn("capped-devices", { name: "first", platform: "linux" });
    const token = String(session["token"]);
    const firstId = String(session["deviceId"]);

    for (let i = 1; i < MAX_DEVICES_PER_USER; i += 1) {
      adoptDevice(db, capped, null, { name: `d${String(i)}`, platform: "linux" });
    }
    check(
      "at the cap, registering another is refused",
      await outcome(
        await send("/v1/me/devices", {
          method: "POST",
          headers: bearer(token),
          body: JSON.stringify({ name: "one too many", platform: "linux" }),
        }),
      ),
      [409, "device_limit"],
    );
    check(
      "⭐ and nothing was evicted — the refusal is what stops one session signing every device out",
      (await json(await send("/v1/me/devices", { headers: bearer(token) })))["devices"] instanceof Array
        ? ((await json(await send("/v1/me/devices", { headers: bearer(token) })))["devices"] as unknown[]).length
        : -1,
      MAX_DEVICES_PER_USER,
    );
    check(
      "a sign-in still succeeds at the cap, which is why the refusal is affordable",
      typeof (await signIn("capped-devices", { name: "another", platform: "linux" }))["token"],
      "string",
    );
    check(
      "and that sign-in simply carries no device",
      (await signIn("capped-devices", { name: "another", platform: "linux" }))["deviceId"],
      null,
    );
    // The slot is counted live rather than consumed.
    void (await send(`/v1/me/devices/${firstId}`, { method: "DELETE", headers: bearer(token) }));
    const after = await signIn("capped-devices", { name: "after retiring one", platform: "linux" });
    check("retiring one makes room immediately", typeof after["deviceId"], "string");
  }

  {
    // Every pre-existing row has a null device_id and must authenticate without the device statement.
    const legacy = mintSession(db, rina, { ip: null, userAgent: null }, null);
    check(
      "a session with no device authenticates unchanged",
      (await send("/v1/me", { headers: bearer(legacy.token) })).status,
      200,
    );
    check(
      "and the resolver says so rather than leaving it unsaid",
      resolveSession(db, legacy.token).ok ? (resolveSession(db, legacy.token) as { session: { deviceId: string | null } }).session.deviceId : "refused",
      null,
    );
  }

  {
    const named = await signIn("rina-devices", { name: "Studio", platform: "macos" });
    const rows = (await json(await send("/v1/me/sessions", { headers: bearer(String(named["token"])) })))[
      "sessions"
    ] as { current: boolean; deviceName: string | null; deviceId: string | null }[];
    const current = rows.find((row) => row.current);
    check("a session row names the installation it belongs to", current?.deviceName, "Studio");
    check("and carries its id, so a client can group by device", current?.deviceId, named["deviceId"]);
    check(
      "a session with no device says null rather than inventing a name",
      rows.filter((row) => row.deviceId === null).every((row) => row.deviceName === null),
      true,
    );
  }

  {
    // A grant is per user and machine, so two installations of one account reach the same machines.
    const fleetUser = signUp("fleet-devices");
    grant(fleetUser, mine);
    const a = await signIn("fleet-devices", { name: "laptop", platform: "macos" });
    const b = await signIn("fleet-devices", { name: "phone", platform: "ios" });
    check("two devices of one account are two rows", a["deviceId"] !== b["deviceId"], true);
    const machinesFor = async (token: string): Promise<unknown> =>
      ((await json(await send("/v1/machines", { headers: bearer(token) })))["machines"] as { id: string }[])
        .map((row) => row.id)
        .sort();
    check(
      "⭐ and they see the same fleet, because a grant belongs to the person",
      await machinesFor(String(a["token"])),
      await machinesFor(String(b["token"])),
    );
    report(
      "which is a real machine rather than two empty lists agreeing",
      ((await machinesFor(String(a["token"]))) as string[]).length > 0,
      `${String(((await machinesFor(String(a["token"]))) as string[]).length)} machine(s)`,
    );
  }

  {
    const doomed = signUp("doomed-devices");
    const session = await signIn("doomed-devices", { name: "about to go", platform: "linux" });
    check("the account has a device", typeof session["deviceId"], "string");
    const adminKey = newApiKey();
    const adminId = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'devices-admin', 1, ?)").run(adminId, now);
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      adminId,
      adminKey.prefix,
      adminKey.hash,
      now,
    );
    void (await send(`/v1/admin/users/${doomed}`, { method: "DELETE", headers: bearer(adminKey.key) }));
    check(
      "their devices are gone",
      db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").get(doomed)?.["n"],
      0,
    );
  }

  {
    const swept = signUp("swept-devices");
    const id = adoptDevice(db, swept, null, { name: "old", platform: "linux" });
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(
      Date.now() - DEVICE_REVOKED_RETENTION_MS - 1,
      id,
    );
    const kept = adoptDevice(db, swept, null, { name: "recent", platform: "linux" });
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(Date.now(), kept);
    pruneDevices(db);
    check(
      "a device retired long ago is swept",
      db.prepare("SELECT id FROM devices WHERE id = ?").get(id),
      undefined,
    );
    check(
      "and one retired recently is kept, because the list still has to say it happened",
      db.prepare("SELECT id FROM devices WHERE id = ?").get(kept) !== undefined,
      true,
    );
  }

  {
    // The migration guard must read user_sessions' own columns, not the machines-keyed helper, or the ALTER is re-attempted on every open.
    const old = new DatabaseSync(":memory:");
    old.exec(
      "CREATE TABLE user_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, prefix TEXT NOT NULL, " +
        "token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, " +
        "last_seen_at INTEGER NOT NULL, revoked_at INTEGER)",
    );
    old.exec("INSERT INTO user_sessions VALUES ('s_old', 'u_old', 'rs_pre', 'h', 1, 2, 3, NULL)");
    applyControlPlaneSchema(old);
    const columns = new Set(old.prepare("PRAGMA table_info(user_sessions)").all().map((row) => String(row["name"])));
    check("an existing sessions table gains the column", columns.has("device_id"), true);
    check(
      "the row that was there keeps its values and answers null for the new one",
      old.prepare("SELECT id, device_id FROM user_sessions WHERE id = 's_old'").get(),
      { id: "s_old", device_id: null },
    );
    // Idempotent, which is what a second process opening the same file does.
    applyControlPlaneSchema(old);
    check("and applying the schema again changes nothing", old.prepare("SELECT COUNT(*) AS n FROM user_sessions").get()?.["n"], 1);
    check("the devices table arrives with it", old.prepare("PRAGMA table_info(devices)").all().length > 0, true);

    // The device_id index cannot live in schema.sql, which runs before migrate adds the column: asserted on an upgraded database, by column.
    const indexes = old
      .prepare("PRAGMA index_list(user_sessions)")
      .all()
      .map((row) => String(row["name"]));
    check("the index over the new column landed with it", indexes.includes("idx_user_sessions_device"), true);
    check(
      "and it is over that column rather than merely named after it",
      old
        .prepare("PRAGMA index_info(idx_user_sessions_device)")
        .all()
        .map((row) => String(row["name"])),
      ["device_id"],
    );
    old.close();
  }

  {
    // A malformed key is dropped to null and the sign-in still succeeds; driven through the route so the field must reach the column.
    // Strict alphabet: base64url decoding skips unknown characters, so two spellings could name one key.
    const wellFormed = "K".repeat(DEVICE_PUBLIC_KEY_CHARS);
    for (const [what, offered] of [
      ["one character short", "K".repeat(DEVICE_PUBLIC_KEY_CHARS - 1)],
      ["one character long", "K".repeat(DEVICE_PUBLIC_KEY_CHARS + 1)],
      ["the right length with a character from no alphabet", `${"K".repeat(DEVICE_PUBLIC_KEY_CHARS - 1)}!`],
      // Plus is base64 but not base64url: the case a lax decoder accepts.
      ["the right length in the wrong base64 alphabet", `${"K".repeat(DEVICE_PUBLIC_KEY_CHARS - 1)}+`],
    ] as const) {
      const signedIn = await signIn("rina-devices", { name: "misencoded", platform: "linux", publicKey: offered });
      check(`a key ${what} does not stop the sign-in`, typeof signedIn["token"], "string");
      check("and the installation is registered anyway", typeof signedIn["deviceId"], "string");
      check("but no key is kept for it", deviceKeyFor(db, String(signedIn["deviceId"])), null);
    }

    const good = await signIn("rina-devices", { name: "well-formed", platform: "linux", publicKey: wellFormed });
    check("a well-formed key is kept", deviceKeyFor(db, String(good["deviceId"])), wellFormed);
  }
}

// The Authority half of device binding; authcheck drives the daemon's comparison.

process.stdout.write("\na capability, and the device it is bound to\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));

  const person = newId("u");
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(person, "capholder", now);
  const capMachine = addMachine("m_cap");
  grant(person, capMachine);

  const laptopKey = "L".repeat(DEVICE_PUBLIC_KEY_CHARS);
  const phoneKey = "P".repeat(DEVICE_PUBLIC_KEY_CHARS);
  const laptop = adoptDevice(db, person, null, { name: "laptop", platform: "macos", publicKey: laptopKey });
  const phone = adoptDevice(db, person, null, { name: "phone", platform: "ios", publicKey: phoneKey });
  report("one account holds two installations", laptop !== phone, `${laptop} and ${phone}`);
  check("each keeps its own key", [deviceKeyFor(db, laptop), deviceKeyFor(db, phone)], [laptopKey, phoneKey]);

  const sessionFor = (deviceId: string | null): string =>
    mintSession(db, person, { ip: null, userAgent: null }, deviceId, now).token;
  const mint = async (token: string): Promise<Response> =>
    send("/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: capMachine }),
    });

  const issued = await mint(sessionFor(laptop));
  check("a signed-in installation is minted a capability", issued.status, 200);
  const body = (await issued.json()) as { token: string; machine: { key: string | null } };
  const claims = parseClaims(Buffer.from(body.token.split(".")[1] ?? "", "base64url").toString("utf8"));

  // cnf.jkt is the key's thumbprint, computed by the one function both sides use.
  check(
    "and it names the key of the installation that asked",
    claims?.cnf?.jkt ?? null,
    jwkThumbprint(x25519Jwk(Buffer.from(laptopKey, "base64url"))),
  );
  check("and names the installation, for a refusal that can be acted on", claims?.dev ?? null, laptop);

  const phoneIssued = await mint(sessionFor(phone));
  const phoneBody = (await phoneIssued.json()) as { token: string };
  const phoneClaims = parseClaims(Buffer.from(phoneBody.token.split(".")[1] ?? "", "base64url").toString("utf8"));
  report(
    "the other installation is minted a different binding on the same machine",
    phoneClaims?.cnf?.jkt !== undefined && phoneClaims.cnf.jkt !== claims?.cnf?.jkt,
    `${String(phoneClaims?.cnf?.jkt).slice(0, 8)}… against ${String(claims?.cnf?.jkt).slice(0, 8)}…`,
  );
  check("and both carry the same grant", phoneClaims?.aud ?? null, claims?.aud ?? null);

  const keyless = adoptDevice(db, person, null, { name: "keyless", platform: "linux" });
  const refused = await mint(sessionFor(keyless));
  check(
    "an installation with no key is refused a capability",
    [refused.status, ((await refused.json()) as { error?: { code?: string } }).error?.code ?? "ok"],
    [409, "device_key_required"],
  );

  // Recoverable by the client: re-registering the same id writes the key in place and spends no slot; machine.ts retries the mint once.
  const healedKey = "H".repeat(DEVICE_PUBLIC_KEY_CHARS);
  const healed = adoptDevice(db, person, keyless, { name: "keyless", platform: "linux", publicKey: healedKey });
  check("re-registering the same installation adopts its row rather than making one", healed, keyless);
  check("and the key lands on it", deviceKeyFor(db, keyless), healedKey);
  const afterHeal = await mint(sessionFor(keyless));
  check("after which the capability is minted", afterHeal.status, 200);
  const healedClaims = parseClaims(
    Buffer.from(((await afterHeal.json()) as { token: string }).token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );
  check(
    "bound to the key it just registered",
    healedClaims?.cnf?.jkt ?? null,
    jwkThumbprint(x25519Jwk(Buffer.from(healedKey, "base64url"))),
  );

  revokeDevice(db, person, laptop);
  const afterRevoke = await mint(sessionFor(phone));
  check("retiring one installation leaves the other minting", afterRevoke.status, 200);
  // deviceKeyFor reads only a live row, though a retired key stays in the table for thirty days.
  check("while the retired one can no longer be bound to", deviceKeyFor(db, laptop), null);
}

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

  // Credentials by SQL, not the admin route, to skip a scrypt hash each.
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

  check("an ordinary name is well formed", labelIsWellFormed("laptop"), true);
  check("an empty one is not", labelIsWellFormed(""), false);
  check("nor is one with a space in it", labelIsWellFormed("my laptop"), false);
  check("nor one that starts with punctuation", labelIsWellFormed("-laptop"), false);
  check("nor one past sixty-four characters", labelIsWellFormed("a".repeat(65)), false);
  // A label spelled like a machine id would let a token request resolve to the wrong machine.
  check("a label spelled like a machine id is refused", labelIsWellFormed("m_1a2b3c4d"), false);
  // The pre-widening id width is still in old databases.
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
  // MACHINE_LABEL_RESERVED_HELP exists because an id-shaped label passes the character rule.
  check("and says which rule it broke", await message(await post("/v1/machines", { name: "m_deadbeef" }, lovelace.headers)), MACHINE_LABEL_RESERVED_HELP);
  check("where a malformed one gets the other sentence", await message(await post("/v1/machines", { name: "ada/laptop" }, lovelace.headers)), MACHINE_LABEL_HELP);
  // Trimmed rather than refused, so the stored value is asserted.
  const spaced = (await (await post("/v1/machines", { name: "  spaced  " }, lovelace.headers)).json()) as {
    machine: { id: string; name: string };
  };
  check("surrounding space is trimmed off a label", spaced.machine.name, "spaced");
  check("and that is what is stored", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(spaced.machine.id)?.["label"], "spaced");

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
    // machines.name is globally UNIQUE and never altered, so a rename touches only machine_owners.label (qualifiedName).
    check("and the row's own name does not move", storedName(), before);
    report("which is still the qualified one", before.startsWith("workbench-"), before);

    // Through the route, nameVisibleTo refuses first.
    check("renaming onto a name you can already see is a 409", await outcome(await send(`/v1/machines/${box.machine.id}`, { method: "PATCH", headers: lovelace.headers, body: JSON.stringify({ name: "spaced" }) })), [409, "machine_exists"]);
    // The unique index directly: relabelMachine carries user_id in its own WHERE.
    check("and the index underneath says the same thing", relabelMachine(db, box.machine.id, lovelace.id, "spaced"), { error: "label_taken" });
    check("but a free label lands", relabelMachine(db, box.machine.id, lovelace.id, "bench-two"), null);
    relabelMachine(db, box.machine.id, admin.id, "stolen");
    check("a caller who is not the owner renames nothing", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(box.machine.id)?.["label"], "bench-two");
  }

  {
    // releaseOwner frees both the label and the quota slot of a revoked machine.
    // Filled by SQL: the count createOwnedMachine reads is machine_owners.
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
    // Creating a machine mints one enrollment code, so the revoke burns exactly one.
    check("revoking reports what it burned", [revoked.revoked, revoked.enrollmentCodesInvalidated], [true, 1]);
    check("the quota slot comes back", owned(), MAX_MACHINES_PER_USER - 1);
    check("and so does the label", (await post("/v1/machines", { name: "spare" }, capped.headers)).status, 201);
    check("a second revoke of the same machine is a 404", await outcome(await post(`/v1/machines/${spare.machine.id}/revoke`, {}, capped.headers)), [404, "machine_not_found"]);
  }

  {
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
    // Inserted out of created_at order, so ordering by rowid, insertion, id or label would disagree.
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

    setLimit(3);
    check("raising the limit un-suspends, with no other act", overOf(), []);
    setLimit(1);
    check("and lowering it again takes the newest two", overOf(), [second, third].sort());

    setLimit(2);
    check("with a limit of two again, only the newest is over", overOf(), [third].sort());

    {
      const rows = (
        (await (await send("/v1/machines", { headers: limited.headers })).json()) as {
          machines: { id: string; overLimit: boolean; ownerDisabled: boolean }[];
        }
      ).machines;
      check("the listing draws the suspended machine and says which", rows.filter((row) => row.overLimit).map((row) => row.id), [third]);
      check("and claims no ban while there is none", rows.every((row) => row.ownerDisabled === false), true);
    }

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

    // Self-contained: banning `limited` would change every assertion after it.
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

      check(
        "and is told the owner is banned, never that they are",
        await outcome(await post("/v1/tokens", { machine: machineId }, grantee.headers)),
        [403, "owner_disabled"],
      );

      db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(owner.id);
      check(
        "un-banning brings it back with nobody touching a host",
        (await post("/v1/tokens", { machine: machineId }, grantee.headers)).status,
        200,
      );
    }

    {
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

    {
      const variable = envNameFor("machines.per_user");
      const held = process.env[variable];
      delete process.env[variable];
      clearSetting(db, "machines.per_user");
      check("unset is the behaviour before this setting existed", instanceMachineLimit(db), MAX_MACHINES_PER_USER);

      writeSetting(db, "machines.per_user", "2", "u_admin");
      check("a row is the instance default", instanceMachineLimit(db), 2);
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
      // Written by SQL, as a release with a higher ceiling would have left it; the read side clamps.
      db.prepare(
        "INSERT INTO user_machine_limits (user_id, max_machines, updated_at, updated_by) VALUES (?, ?, ?, ?)",
      ).run(ceilinged.id, 999, now, "u_admin");
      check("and a row written past it still reads as the ceiling", effectiveLimit(db, ceilinged.id).limit, MAX_MACHINES_PER_USER);
      clearMachineLimit(db, ceilinged.id);
    }

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

    {
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

      await post(`/v1/machines/${held}/enrollments`, {}, keeper.headers);
      const liveCodes = (): number =>
        Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM enrollment_codes WHERE machine_id = ? AND used_at IS NULL")
            .get(held)?.["n"] ?? 0,
        );
      check("the owner holds a live code going in", liveCodes(), 1);

      const before = acquiredAt();
      const relabelled = (await (
        await send(`/v1/admin/machines/${held}/owner`, {
          method: "PUT",
          headers: admin.headers,
          body: JSON.stringify({ userId: keeper.id, label: "renamed" }),
        })
      ).json()) as { enrollmentCodesInvalidated: number };
      check("re-labelling a machine its owner already owns keeps when they acquired it", acquiredAt(), before);
      check("and burns none of their enrollment codes", relabelled.enrollmentCodesInvalidated, 0);
      check("which is a fact about the table, not only about the answer", liveCodes(), 1);

      const ownerRow = (): [string, string] => {
        const row = db.prepare("SELECT user_id, label FROM machine_owners WHERE machine_id = ?").get(held);
        return [String(row?.["user_id"] ?? ""), String(row?.["label"] ?? "")];
      };
      check(
        "taking a machine away from the owner it has is refused",
        await outcome(
          await send(`/v1/admin/machines/${held}/owner`, {
            method: "PUT",
            headers: admin.headers,
            body: JSON.stringify({ userId: taker.id, label: "taken" }),
          }),
        ),
        [403, "machine_owned"],
      );
      check("and the ownership row is exactly as it was", ownerRow(), [keeper.id, "renamed"]);
      report("so when they acquired it did not move either", acquiredAt() === before, `${before} -> ${acquiredAt()}`);
      check(
        "while an ownerless legacy row is still adoptable, which is what the route is for",
        await (async () => {
          const legacy = newId("m");
          db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
            legacy,
            `legacy-${legacy}`,
            now,
            now,
          );
          return outcome(
            await send(`/v1/admin/machines/${legacy}/owner`, {
              method: "PUT",
              headers: admin.headers,
              body: JSON.stringify({ userId: taker.id, label: "adopted" }),
            }),
          );
        })(),
        [200, "ok"],
      );
    }

    {
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

  {
    const provisioned = withKey("provisionadmin", true);
    const target = withKey("provisionee");
    // No authorization header: the provisioning key is not a person's credential.
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
    check(
      "and carries no key material of any kind",
      Object.keys(
        (await (await send("/v1/admin/provisioning-key", { headers: provisioned.headers })).json()) as object,
      ),
      ["minted"],
    );

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
    report(
      "the enrollment code records the key that minted it, not the owner",
      String(
        db.prepare("SELECT created_by FROM enrollment_codes WHERE machine_id = ?").get(answer.machine.id)?.["created_by"],
      ).startsWith("pk_"),
      String(db.prepare("SELECT created_by FROM enrollment_codes WHERE machine_id = ?").get(answer.machine.id)?.["created_by"]),
    );

    writeMachineLimit(db, target.id, 1, "u_admin");
    const second = (await (
      await post("/v1/provision", { key: first, user: target.id, machine: "second" }, bare)
    ).json()) as { machineLimitRaisedTo: number | null };
    // owned + 1, not limit + 1: exactly enough for the machine being provisioned.
    check("at their limit, provisioning raises it to fit and no further", second.machineLimitRaisedTo, 2);
    // Scoped to this user: overLimitMachineIds is fleet-wide and earlier blocks leave machines over their limits.
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

    const reminted = await mintKey();
    check(
      "reminting stops the old key at once",
      await outcome(await post("/v1/provision", { key: first, user: target.id, machine: "stale" }, bare)),
      [401, "invalid_provisioning_key"],
    );
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
    db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(now, target.id);
    check(
      "and a banned user is refused rather than given a dead machine",
      await outcome(await post("/v1/provision", { key: reminted, user: target.id, machine: "banned" }, bare)),
      [403, "user_disabled"],
    );
    db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(target.id);
    clearMachineLimit(db, target.id);

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
        "provisioning for somebody already over their limit is refused",
        await outcome(await post("/v1/provision", { key: reminted, user: full.id, machine: "fiftyfirst" }, bare)),
        [409, "machine_limit"],
      );
      check(
        "and it says which state it is refusing, since an admin put them in it",
        (await message(await post("/v1/provision", { key: reminted, user: full.id, machine: "fiftyfirst" }, bare)))
          .includes("are switched off"),
        true,
      );
      check("and the refusal left their limit exactly as it found it", effectiveLimit(db, full.id).limit, 5);
      report(
        "so nothing was un-suspended by a request that failed",
        [...overLimitMachineIds(db)].length === suspendedBefore,
        `${[...overLimitMachineIds(db)].length} over, was ${suspendedBefore}`,
      );

      // Cleared rather than set: unset means the ceiling, so owned equals the limit and only the ceiling arm refuses (Q1.503).
      clearMachineLimit(db, full.id);
      const atCeiling = [...overLimitMachineIds(db)].length;
      check(
        "provisioning at the fleet ceiling is refused",
        await outcome(await post("/v1/provision", { key: reminted, user: full.id, machine: "fiftyfirst" }, bare)),
        [409, "machine_limit"],
      );
      check(
        "and that one names the ceiling rather than a suspension",
        (await message(await post("/v1/provision", { key: reminted, user: full.id, machine: "fiftyfirst" }, bare)))
          .includes("fleet-wide ceiling"),
        true,
      );
      check("and the ceiling refusal wrote no limit either", effectiveLimit(db, full.id).source, "default");
      report(
        "and it un-suspended nothing on the way out",
        [...overLimitMachineIds(db)].length === atCeiling,
        `${[...overLimitMachineIds(db)].length} over, was ${atCeiling}`,
      );
    }

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

    // Last, deliberately: it spends this address's provisionKey budget, so every /v1/provision above would answer 429 after it.
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

  {
    // Only a shared machine and a case-only label difference discriminate: a same-case owned name is refused by the unique index either way.
    const shared = withKey("hollerith");
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES ('m_legacy_bb', 'buildbox', ?)").run(now);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, 'm_legacy_bb', 'session:read', ?)").run(shared.id, now);

    check("her own route refuses a name she can already see", await outcome(await post("/v1/machines", { name: "buildbox" }, shared.headers)), [409, "machine_exists"]);
    check("and so does an admin registering it for her", await outcome(await post("/v1/admin/machines", { name: "buildbox", ownerId: shared.id }, admin.headers)), [409, "machine_exists"]);

    check("a machine she owns is registered", (await post("/v1/machines", { name: "desk" }, shared.headers)).status, 201);
    check("and the admin door refuses it spelled in another case", await outcome(await post("/v1/admin/machines", { name: "DESK", ownerId: shared.id }, admin.headers)), [409, "machine_exists"]);

    const registered = await post("/v1/admin/machines", { name: "plotter", ownerId: shared.id }, admin.headers);
    check("a name nobody can see still registers", registered.status, 201);
    const registeredId = ((await registered.json()) as { id?: string }).id ?? "";
    const plotter = ((await (await send("/v1/machines", { headers: shared.headers })).json()) as {
      machines: { id: string; name: string; owned?: boolean }[];
    }).machines.find((machine) => machine.id === registeredId);
    check("and lands in her list, owned, under the label the admin chose", [plotter?.name, plotter?.owned], ["plotter", true]);

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

  {
    // The qualified row name is reported, not assumed: were it the bare label, the refusals below would come from the global check and prove nothing.
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
    check("and case does not dodge it", await outcome(await rename("m_legacy_rn", "LAPTOP")), [409, "machine_exists"]);
    check("the row keeps the name it had", rowName("m_legacy_rn"), "rackmount");

    check("a name nobody can see still renames", (await rename("m_legacy_rn", "rack-two")).status, 200);
    check("and the row moves", rowName("m_legacy_rn"), "rack-two");

    check("a machine she owns is registered", (await post("/v1/machines", { name: "desk" }, ada.headers)).status, 201);
    check("the owner's own list does not block a rename of the row behind it", (await rename(hers.machine.id, "desk")).status, 200);
    check("and her label is untouched", db.prepare("SELECT label FROM machine_owners WHERE machine_id = ?").get(hers.machine.id)?.["label"], "laptop");

    const kilburn = withKey("kilburn");
    check("a second person has a machine of their own", (await post("/v1/machines", { name: "bench" }, kilburn.headers)).status, 201);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, 'session:read', ?)").run(kilburn.id, hers.machine.id, now);
    check("and a grantee who is not the owner is shadowed the same way", await outcome(await rename(hers.machine.id, "bench")), [409, "machine_exists"]);
  }

  {
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
    const row = db.prepare("SELECT created_by, used_from FROM enrollment_codes WHERE machine_id = ?").get(theirs.machine.id);
    check("burned as a deletion rather than as a revocation", row?.["used_from"], "user_deleted");
    check("and the audit row still names who minted it", row?.["created_by"], leaving.id);

    const lastGrantee = withKey("last-grantee");
    const stranded = newId("m");
    const bystander = newId("m");
    for (const machineId of [stranded, bystander]) {
      db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        `${machineId}-name`,
        Date.now(),
        Date.now(),
      );
    }
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      lastGrantee.id,
      stranded,
      "session:read",
      Date.now(),
    );
    const revokedAt = (machineId: string): unknown =>
      db.prepare("SELECT revoked_at FROM machines WHERE id = ?").get(machineId)?.["revoked_at"];
    check("both legacy rows are live going in", [revokedAt(stranded), revokedAt(bystander)], [null, null]);

    const swept = (await (
      await send(`/v1/admin/users/${lastGrantee.id}`, { method: "DELETE", headers: admin.headers })
    ).json()) as { machinesRevoked: number };
    check("the delete counts the machine it would have stranded", swept.machinesRevoked, 1);
    check("which is revoked rather than left ownerless and enrolled", revokedAt(stranded) !== null, true);
    check("while a legacy row nobody was on is left alone", revokedAt(bystander), null);
  }

  {
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
    check("burned as a ban rather than as a deletion", db.prepare("SELECT used_from FROM enrollment_codes WHERE machine_id = ?").get(theirs.machine.id)?.["used_from"], "user_disabled");
    check("enabling them again is allowed", (await post(`/v1/admin/users/${banned.id}/enable`, {}, admin.headers)).status, 200);
    check("and does not give the code back", await outcome(await post("/v1/enroll", { code: theirs.enrollment.code }, { "content-type": "application/json" })), [409, "code_unusable"]);
  }

  {
    const holder = withKey("handed-a-code");
    // Registered through the admin door: the holder's own route would mint a code as created_by, and the admin mint refuses over it with code_outstanding.
    const theirs = { machine: { id: "" } };
    theirs.machine.id = String(
      (
        (await (
          await post("/v1/admin/machines", { name: "handed-box", ownerId: holder.id }, admin.headers)
        ).json()) as { id: unknown }
      ).id,
    );
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

  // Last, deliberately: it spends this address's enrollKey budget, so every /v1/enroll above would answer 429 if it ran first.

  {
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
    check(
      "and it has not touched signing in from the same address",
      (await post("/v1/login", { name: "fleetadmin", password: "no such password" }, bare)).status,
      401,
    );
  }

  {
    // Built by SQL: no route creates a machine without an owner.
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
    check("with every scope", [...((await adopted.json()) as { scopes: string[] }).scopes].sort(), ["machine:admin", "session:read", "session:write"]);
    const listed = ((await (await send("/v1/machines", { headers: turing.headers })).json()) as {
      machines: { id: string; name: string; owned?: boolean }[];
    }).machines.find((machine) => machine.id === orphan.id);
    check("and it appears in their list, under their own label", [listed?.name, listed?.owned], ["adopted", true]);

    check("rename now works", (await patch(turing.headers, "adopted-two")).status, 200);
    check("so does re-enrolling", (await post(`/v1/machines/${orphan.id}/enrollments`, {}, turing.headers)).status, 201);
    check("and so does retiring it", (await post(`/v1/machines/${orphan.id}/revoke`, {}, turing.headers)).status, 200);
    check("a revoked machine is not adoptable", await outcome(await send(`/v1/admin/machines/${orphan.id}/owner`, { method: "PUT", headers: admin.headers, body: JSON.stringify({ userId: turing.id, label: "again" }) })), [403, "machine_revoked"]);
  }

  {
    const sharer = withKey("sharer");
    const guest = withKey("guest");
    const shared = (await (await post("/v1/machines", { name: "sharebox" }, sharer.headers)).json()) as {
      machine: { id: string };
    };
    const box = shared.machine.id;
    const sees = async (headers: Record<string, string>): Promise<boolean> =>
      ((await (await send("/v1/machines", { headers })).json()) as { machines: { id: string }[] }).machines.some(
        (machine) => machine.id === box,
      );
    const share = (headers: Record<string, string>, userId: string, scopes: string[]): Promise<Response> =>
      send(`/v1/machines/${box}/grants`, { method: "PUT", headers, body: JSON.stringify({ userId, scopes }) });

    // Read the code, not the status: a restored DELETE would also answer 404 as grant_not_found, while an unregistered path answers not_found.
    check(
      "the admin write routes are gone rather than guarded",
      [
        await outcome(
          await send("/v1/admin/grants", {
            method: "PUT",
            headers: admin.headers,
            body: JSON.stringify({ userId: guest.id, machineId: box, scopes: ["session:read"] }),
          }),
        ),
        await outcome(
          await send(`/v1/admin/grants?userId=${guest.id}&machineId=${box}`, {
            method: "DELETE",
            headers: admin.headers,
          }),
        ),
      ],
      [
        [404, "not_found"],
        [404, "not_found"],
      ],
    );
    check("while the read is deliberately kept", (await send("/v1/admin/grants?limit=1", { headers: admin.headers })).status, 200);

    check("a machine nobody shared is not in your list", await sees(guest.headers), false);
    check(
      "somebody who is not the owner cannot share it, and is not told it exists",
      await outcome(await share(guest.headers, guest.id, ["session:read"])),
      [404, "machine_not_found"],
    );
    check("an admin cannot either, because there is no admin door left", await sees(admin.headers), false);
    check("the owner can", (await share(sharer.headers, guest.id, ["session:read"])).status, 200);
    check("and then it is in their list", await sees(guest.headers), true);
    check(
      "the owner sees who they shared it with",
      ((await (await send(`/v1/machines/${box}/grants`, { headers: sharer.headers })).json()) as {
        grants: { userId: string; scopes: string[] }[];
      }).grants.map((grant) => [grant.userId, grant.scopes.join(",")]),
      [[guest.id, "session:read"]],
    );
    check(
      "the owner may not re-scope their own grant",
      await outcome(await share(sharer.headers, sharer.id, ["session:read"])),
      [409, "grant_is_owner"],
    );
    check(
      "nor remove it, which would hide the machine from its own owner",
      await outcome(
        await send(`/v1/machines/${box}/grants?userId=${sharer.id}`, { method: "DELETE", headers: sharer.headers }),
      ),
      [409, "grant_is_owner"],
    );
    check("an unknown user is a 404", await outcome(await share(sharer.headers, "u_nobody", ["session:read"])), [404, "user_not_found"]);
    check("and a scope this service does not know is refused whole", await outcome(await share(sharer.headers, guest.id, ["session:read", "root"])), [400, "bad_request"]);
    check(
      "a share can be widened",
      await (async () => {
        await share(sharer.headers, guest.id, ["session:read", "session:write"]);
        return ((await (await send(`/v1/machines/${box}/grants`, { headers: sharer.headers })).json()) as {
          grants: { scopes: string[] }[];
        }).grants[0]?.scopes.length;
      })(),
      2,
    );
    check(
      "and taken back",
      await outcome(
        await send(`/v1/machines/${box}/grants?userId=${guest.id}`, { method: "DELETE", headers: sharer.headers }),
      ),
      [200, "ok"],
    );
    check("after which they no longer see it", await sees(guest.headers), false);
    check(
      "and un-sharing twice is a 404 rather than a silent success",
      await outcome(
        await send(`/v1/machines/${box}/grants?userId=${guest.id}`, { method: "DELETE", headers: sharer.headers }),
      ),
      [404, "grant_not_found"],
    );

    {
      const first = withKey("order-first");
      const second = withKey("order-second");
      await share(sharer.headers, first.id, ["session:read"]);
      await share(sharer.headers, second.id, ["session:read"]);
      const listedIds = async (): Promise<string[]> =>
        ((await (await send(`/v1/machines/${box}/grants`, { headers: sharer.headers })).json()) as {
          grants: { userId: string }[];
        }).grants.map((grant) => grant.userId);
      // Both timestamps are stamped by SQL: two share calls often land in one millisecond, and a wall-clock order flakes.
      const apart = Date.now();
      db.prepare("UPDATE grants SET created_at = ? WHERE machine_id = ? AND user_id = ?").run(apart, box, first.id);
      db.prepare("UPDATE grants SET created_at = ? WHERE machine_id = ? AND user_id = ?").run(
        apart + 1,
        box,
        second.id,
      );
      check("two shares list oldest first", await listedIds(), [first.id, second.id]);

      const tied = Date.now();
      db.prepare("UPDATE grants SET created_at = ? WHERE machine_id = ? AND user_id IN (?, ?)").run(
        tied,
        box,
        first.id,
        second.id,
      );
      check(
        "and a same-millisecond tie still ranks, by user id",
        await listedIds(),
        [first.id, second.id].sort((a, b) => (a < b ? -1 : 1)),
      );
      await send(`/v1/machines/${box}/grants?userId=${first.id}`, { method: "DELETE", headers: sharer.headers });
      await send(`/v1/machines/${box}/grants?userId=${second.id}`, { method: "DELETE", headers: sharer.headers });
    }

    {
      await share(sharer.headers, guest.id, ["session:read"]);
      check("a share arrives without the other person being asked", await sees(guest.headers), true);
      check(
        "and the person it was made to can give it up",
        await outcome(await send(`/v1/machines/${box}/grants/me`, { method: "DELETE", headers: guest.headers })),
        [200, "ok"],
      );
      check("after which it is gone from their list", await sees(guest.headers), false);
      check(
        "and leaving again is a 404 rather than a silent success",
        await outcome(await send(`/v1/machines/${box}/grants/me`, { method: "DELETE", headers: guest.headers })),
        [404, "grant_not_found"],
      );
      check(
        "a machine nobody shared with them is the same 404, not a different one",
        await outcome(await send(`/v1/machines/m_nosuch/grants/me`, { method: "DELETE", headers: guest.headers })),
        [404, "grant_not_found"],
      );
      check(
        "and the owner may not leave their own machine",
        await outcome(await send(`/v1/machines/${box}/grants/me`, { method: "DELETE", headers: sharer.headers })),
        [409, "grant_is_owner"],
      );
      check("so the owner still sees it", await sees(sharer.headers), true);
    }

    await share(sharer.headers, guest.id, ["session:read"]);
    const stranger = withKey("share-stranger");
    check(
      "somebody who is not the owner cannot un-share it either",
      await outcome(
        await send(`/v1/machines/${box}/grants?userId=${guest.id}`, { method: "DELETE", headers: stranger.headers }),
      ),
      [404, "machine_not_found"],
    );
    check(
      "and the grant it was aimed at is still there",
      db.prepare("SELECT COUNT(*) AS n FROM grants WHERE machine_id = ? AND user_id = ?").get(box, guest.id)?.["n"],
      1,
    );

    check(
      "a non-owner may not read who a machine is shared with",
      await outcome(await send(`/v1/machines/${box}/grants`, { headers: stranger.headers })),
      [404, "machine_not_found"],
    );
    check(
      "and an id that exists nowhere is indistinguishable from one that does",
      await outcome(await send("/v1/machines/m_0f1e2d3c/grants", { headers: stranger.headers })),
      [404, "machine_not_found"],
    );

    const suspended = withKey("suspended-guest");
    check("an account can be suspended", (await post(`/v1/admin/users/${suspended.id}/disable`, {}, admin.headers)).status, 200);
    check(
      "and a machine may not then be shared with them",
      await outcome(await share(sharer.headers, suspended.id, ["session:read"])),
      [409, "user_disabled"],
    );
    check(
      "with nothing written that an enable would bring to life",
      db.prepare("SELECT COUNT(*) AS n FROM grants WHERE machine_id = ? AND user_id = ?").get(box, suspended.id)?.["n"],
      0,
    );

    check(
      "un-sharing with no userId at all says the request is wrong",
      await outcome(await send(`/v1/machines/${box}/grants`, { method: "DELETE", headers: sharer.headers })),
      [400, "bad_request"],
    );
    check(
      "and an empty one says it too, rather than matching no row",
      await outcome(await send(`/v1/machines/${box}/grants?userId=`, { method: "DELETE", headers: sharer.headers })),
      [400, "bad_request"],
    );
    check(
      "with the grant that was there untouched by either",
      db.prepare("SELECT COUNT(*) AS n FROM grants WHERE machine_id = ? AND user_id = ?").get(box, guest.id)?.["n"],
      1,
    );

    const malformedShares: [string, string | undefined][] = [
      ["no body at all", undefined],
      ["a bare string where an object belongs", JSON.stringify("not an object")],
      ["an empty object", JSON.stringify({})],
      ["a userId that is not a string", JSON.stringify({ userId: 7, scopes: ["session:read"] })],
      ["an empty userId", JSON.stringify({ userId: "", scopes: ["session:read"] })],
      ["a userId with no scopes beside it", JSON.stringify({ userId: guest.id })],
    ];
    const shareAnswers: string[] = [];
    for (const [what, body] of malformedShares) {
      const answer = await outcome(
        await send(`/v1/machines/${box}/grants`, {
          method: "PUT",
          headers: sharer.headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      shareAnswers.push(`${what}: ${answer.join(" ")}`);
    }
    check(
      "every malformed share body is one bad request rather than six answers",
      shareAnswers,
      malformedShares.map(([what]) => `${what}: 400 bad_request`),
    );
    // Two rows: the owner's own grant and the guest's re-share above.
    check(
      "and not one of them left a row behind",
      db.prepare("SELECT COUNT(*) AS n FROM grants WHERE machine_id = ?").get(box)?.["n"],
      2,
    );
  }

  {
    // Its own app: the write throttle is per instance, and the shared one's public budget is spent by now.
    const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
    const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
      send(path, { method: "POST", headers, body: JSON.stringify(body) });

    const rooted = withKey("rooted");
    const live = (await (await post("/v1/machines", { name: "livebox" }, rooted.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    check(
      "the machine enrolls",
      await outcome(await post("/v1/enroll", { code: live.enrollment.code }, { "content-type": "application/json" })),
      [200, "ok"],
    );

    check(
      "an admin may not mint a code for an enrolled machine somebody owns",
      await outcome(await post(`/v1/admin/machines/${live.machine.id}/enrollments`, {}, admin.headers)),
      [409, "machine_enrolled"],
    );
    check(
      "while its owner still may, which is what re-installing a host is",
      (await post(`/v1/machines/${live.machine.id}/enrollments`, {}, rooted.headers)).status,
      201,
    );
    const fresh = (await (await send("/v1/admin/machines", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ name: "wizardbox", ownerId: rooted.id }),
    })).json()) as { id: string };
    check(
      "the installer's wizard is untouched, because that machine has never enrolled",
      (await post(`/v1/admin/machines/${fresh.id}/enrollments`, {}, admin.headers)).status,
      201,
    );
    check(
      "and the admin may re-mint over their own code, which is the lost-the-paste retry",
      (await post(`/v1/admin/machines/${fresh.id}/enrollments`, {}, admin.headers)).status,
      201,
    );

    const holder = withKey("mid-install");
    const installing = (await (await post("/v1/machines", { name: "installing-box" }, holder.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    check(
      "an admin may not mint over a live code its owner is holding",
      await outcome(await post(`/v1/admin/machines/${installing.machine.id}/enrollments`, {}, admin.headers)),
      [409, "code_outstanding"],
    );
    check(
      "and the owner's code is still theirs to redeem, which is the half a status cannot show",
      await outcome(
        await post("/v1/enroll", { code: installing.enrollment.code }, { "content-type": "application/json" }),
      ),
      [200, "ok"],
    );
    const legacy = newId("m");
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
      legacy,
      `legacy-${legacy}`,
      now,
      now,
    );
    check(
      "and an ownerless legacy machine is still the operator's to re-enroll",
      (await post(`/v1/admin/machines/${legacy}/enrollments`, {}, admin.headers)).status,
      201,
    );

    const heldLegacy = newId("m");
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
      heldLegacy,
      `legacy-${heldLegacy}`,
      now,
      now,
    );
    const legacyGrantee = withKey("legacy-grantee");
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      legacyGrantee.id,
      heldLegacy,
      "session:read session:write",
      now,
    );
    check(
      "an enrolled legacy machine somebody holds a grant on may not be re-enrolled either",
      await outcome(await post(`/v1/admin/machines/${heldLegacy}/enrollments`, {}, admin.headers)),
      [409, "machine_enrolled"],
    );
    check(
      "and the refusal wrote no code that could be redeemed later",
      db.prepare("SELECT COUNT(*) AS n FROM enrollment_codes WHERE machine_id = ?").get(heldLegacy)?.["n"],
      0,
    );

    const legacyStranger = withKey("legacy-stranger");
    const adopt = (userId: string, label: string): Promise<Response> =>
      send(`/v1/admin/machines/${heldLegacy}/owner`, {
        method: "PUT",
        headers: admin.headers,
        body: JSON.stringify({ userId, label }),
      });
    check(
      "nor may it be adopted by somebody who is not one of them",
      await outcome(await adopt(legacyStranger.id, "seized")),
      [403, "machine_granted"],
    );
    check(
      "and the refusal left it ownerless rather than half-adopted",
      db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE machine_id = ?").get(heldLegacy)?.["n"],
      0,
    );
    check("while handing it to the person already on it is allowed", (await adopt(legacyGrantee.id, "regularised")).status, 200);
    check(
      "which gives them the owner's verbs, which is what they had none of",
      (await post(`/v1/machines/${heldLegacy}/enrollments`, {}, legacyGrantee.headers)).status,
      201,
    );

    const stranded = newId("m");
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
      stranded,
      `legacy-${stranded}`,
      now,
      now,
    );
    const kept = (await (await post(`/v1/admin/machines/${stranded}/enrollments`, {}, admin.headers)).json()) as {
      code: string;
    };
    const handedOver = await send(`/v1/admin/machines/${stranded}/owner`, {
      method: "PUT",
      headers: admin.headers,
      body: JSON.stringify({ userId: withKey("late-adopter").id, label: "handed-over" }),
    });
    check("an enrolled orphan with no grantee is still the operator's to adopt", handedOver.status, 200);
    check(
      "and the adoption says how many codes it burned doing it",
      ((await handedOver.json()) as { enrollmentCodesInvalidated: number }).enrollmentCodesInvalidated,
      1,
    );
    check(
      "so a code kept back cannot substitute the machine after it has an owner",
      await outcome(await post("/v1/enroll", { code: kept.code }, { "content-type": "application/json" })),
      [409, "code_unusable"],
    );
  }

  {
    // Its own app, for the throttle reason the block above gives.
    const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
    const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
      send(path, { method: "POST", headers, body: JSON.stringify(body) });

    const victim = withKey("victim");
    const first = (await (await post("/v1/machines", { name: "workstation" }, victim.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    await post("/v1/enroll", { code: first.enrollment.code }, { "content-type": "application/json" });
    const rowOf = async (name: string): Promise<{ id: string; enrolledBy: string | null } | undefined> =>
      ((await (await send("/v1/machines", { headers: victim.headers })).json()) as {
        machines: { id: string; name: string; enrolledBy: string | null }[];
      }).machines.find((machine) => machine.name === name);
    // Checked against the row, not through a nullish fallback, which would make a correct null and a missing row one answer.
    const mine = await rowOf("workstation");
    report(
      "a machine you enrolled yourself names nobody",
      mine !== undefined && mine.enrolledBy === null,
      `${mine === undefined ? "no row" : String(mine.enrolledBy)}`,
    );

    check("the admin revokes it", (await post(`/v1/admin/machines/${first.machine.id}/revoke`, {}, admin.headers)).status, 200);
    const replaced = (await (await send("/v1/admin/machines", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ name: "workstation", ownerId: victim.id }),
    })).json()) as { id: string };
    report("and the freed name is available again", replaced.id !== first.machine.id, `${first.machine.id} -> ${replaced.id}`);
    const substituted = (await (await post(`/v1/admin/machines/${replaced.id}/enrollments`, {}, admin.headers)).json()) as {
      code: string;
    };
    await post("/v1/enroll", { code: substituted.code }, { "content-type": "application/json" });

    const now2 = await rowOf("workstation");
    report("the substitution completes — this is the composition, stated", now2?.id === replaced.id, `${now2?.id}`);
    check("but the owner's own list names who enrolled it", now2?.enrolledBy, "fleetadmin");
  }

  {
    // Its own app for the throttle reason above, and because the provisioning section exhausts the shared /v1/provision budget.
    const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
    const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
    const post = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> =>
      send(path, { method: "POST", headers, body: JSON.stringify(body) });
    const bare = { "content-type": "application/json" };

    // A machine missing from the listing gets its own answer, so it cannot pass as a correct null.
    const enrolledBy = async (
      headers: Record<string, string>,
      machineId: string,
    ): Promise<string | null> => {
      const row = (
        (await (await send("/v1/machines", { headers })).json()) as {
          machines: { id: string; enrolledBy: string | null }[];
        }
      ).machines.find((machine) => machine.id === machineId);
      return row === undefined ? "no row" : row.enrolledBy;
    };

    const superseder = withKey("code-superseder");
    const wizarded = (await (
      await send("/v1/admin/machines", {
        method: "POST",
        headers: admin.headers,
        body: JSON.stringify({ name: "wizard-install", ownerId: superseder.id }),
      })
    ).json()) as { id: string };
    const wizardCode = (await (
      await post(`/v1/admin/machines/${wizarded.id}/enrollments`, {}, admin.headers)
    ).json()) as { code: string };
    check("a machine the admin enrolled comes online", await outcome(await post("/v1/enroll", { code: wizardCode.code }, bare)), [200, "ok"]);
    check("and its owner is told who did it", await enrolledBy(superseder.headers, wizarded.id), "fleetadmin");
    check(
      "the owner may mint their own code, twice, redeeming neither",
      [
        (await post(`/v1/machines/${wizarded.id}/enrollments`, {}, superseder.headers)).status,
        (await post(`/v1/machines/${wizarded.id}/enrollments`, {}, superseder.headers)).status,
      ],
      [201, 201],
    );
    check("and the machine still names the admin rather than them", await enrolledBy(superseder.headers, wizarded.id), "fleetadmin");

    const shortLived = withKey("shortlived-admin", true);
    const outlives = withKey("outlives-the-admin");
    const handedDown = (await (
      await send("/v1/admin/machines", {
        method: "POST",
        headers: shortLived.headers,
        body: JSON.stringify({ name: "handed-down", ownerId: outlives.id }),
      })
    ).json()) as { id: string };
    const theirCode = (await (
      await post(`/v1/admin/machines/${handedDown.id}/enrollments`, {}, shortLived.headers)
    ).json()) as { code: string };
    check("a second admin's code enrolls it", await outcome(await post("/v1/enroll", { code: theirCode.code }, bare)), [200, "ok"]);
    check("and names them while the account exists", await enrolledBy(outlives.headers, handedDown.id), "shortlived-admin");
    check(
      "that admin account can be deleted",
      await outcome(await send(`/v1/admin/users/${shortLived.id}`, { method: "DELETE", headers: admin.headers })),
      [200, "ok"],
    );
    check(
      "and the machine still says somebody else brought it online",
      await enrolledBy(outlives.headers, handedDown.id),
      "a deleted account",
    );

    const provisionee = withKey("pk-provisionee");
    const provisionKeyValue = (
      (await (await send("/v1/admin/provisioning-key", { method: "POST", headers: admin.headers })).json()) as {
        key: string;
      }
    ).key;
    const provisioned = (await (
      await post("/v1/provision", { key: provisionKeyValue, user: provisionee.id, machine: "provisioned-host" }, bare)
    ).json()) as { machine: { id: string }; enrollment: { code: string } };
    check("a provisioned machine enrols on the key's own code", await outcome(await post("/v1/enroll", { code: provisioned.enrollment.code }, bare)), [200, "ok"]);
    check(
      "and its owner is told a key brought it online rather than nobody",
      await enrolledBy(provisionee.headers, provisioned.machine.id),
      "a provisioning key",
    );

    const shareHost = withKey("share-host");
    const shareVisitor = withKey("share-visitor");
    const ownBox = (await (await post("/v1/machines", { name: "hostbox" }, shareHost.headers)).json()) as {
      machine: { id: string };
      enrollment: { code: string };
    };
    check("an owner enrols their own machine", await outcome(await post("/v1/enroll", { code: ownBox.enrollment.code }, bare)), [200, "ok"]);
    check("so their own list names nobody", await enrolledBy(shareHost.headers, ownBox.machine.id), null);
    check(
      "sharing it with somebody works",
      (
        await send(`/v1/machines/${ownBox.machine.id}/grants`, {
          method: "PUT",
          headers: shareHost.headers,
          body: JSON.stringify({ userId: shareVisitor.id, scopes: ["session:read"] }),
        })
      ).status,
      200,
    );
    check(
      "and the grantee reads the owner's name, which is true and is not an alarm",
      await enrolledBy(shareVisitor.headers, ownBox.machine.id),
      "share-host",
    );

    const legacyOwner = withKey("legacy-owner");
    const legacyEnrolled = newId("m");
    const legacyFresh = newId("m");
    for (const [machineId, enrolledAt] of [
      [legacyEnrolled, Date.now()],
      [legacyFresh, null],
    ] as [string, number | null][]) {
      db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        `${machineId}-name`,
        Date.now(),
        enrolledAt,
      );
      db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
        machineId,
        legacyOwner.id,
        machineId === legacyEnrolled ? "legacy-enrolled" : "legacy-fresh",
        Date.now(),
      );
      db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
        legacyOwner.id,
        machineId,
        "session:read",
        Date.now(),
      );
    }
    check(
      "a machine enrolled before the column existed says so rather than nothing",
      await enrolledBy(legacyOwner.headers, legacyEnrolled),
      "somebody this control plane did not record",
    );
    check(
      "while one that has never enrolled has nothing to have recorded",
      await enrolledBy(legacyOwner.headers, legacyFresh),
      null,
    );
    check(
      "and neither is confused with a machine you enrolled yourself",
      (await enrolledBy(legacyOwner.headers, legacyEnrolled)) !== (await enrolledBy(legacyOwner.headers, legacyFresh)),
      true,
    );
  }
}

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

  const hopper = (await (await post("/v1/admin/users", { name: "hopper", isAdmin: true }, superAdmin)).json()) as {
    id: string;
    password: string;
  };
  db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(hopper.id);
  const hers = {
    authorization: `Bearer ${
      ((await (await post("/v1/login", { name: "hopper", password: hopper.password }, { "content-type": "application/json" })).json()) as { token: string }).token
    }`,
    "content-type": "application/json",
  };
  const bystander = (await (await post("/v1/admin/users", { name: "bystander" }, superAdmin)).json()) as { id: string };

  // A session alone mints a key, and a stray currentPassword is ignored rather than verified (Q1.630).
  const second = await post("/v1/me/keys", {}, hers);
  check("minting yourself a key needs only your session", second.status, 201);
  check(
    "and a password in the body is ignored, not verified",
    (await post("/v1/me/keys", { currentPassword: "not-my-password" }, hers)).status,
    201,
  );
  const bodiless = await send("/v1/me/keys", {
    method: "POST",
    headers: { authorization: hers.authorization },
  });
  check("and a request carrying no body mints too", bodiless.status, 201);
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
  const liveKeys = (): number =>
    Number(
      db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL").get(hopper.id)?.["n"] ??
        0,
    );
  const keysBefore = liveKeys();
  // Asserted, not assumed: unchanged over an empty set would prove nothing.
  check("there is a key to keep in the first place", keysBefore > 0, true);
  check(
    "and the change itself lands",
    (await post("/v1/me/password", { currentPassword: hopper.password, newPassword: "a-fine-new-password" }, hers))
      .status,
    200,
  );
  check("changing your own password leaves your keys alone", liveKeys(), keysBefore);

  const curie = (await (await post("/v1/admin/users", { name: "curie" }, superAdmin)).json()) as {
    id: string;
    password: string;
  };
  db.prepare("DELETE FROM password_obligations WHERE user_id = ?").run(curie.id);
  const curieSession = ((await (await post("/v1/login", { name: "curie", password: curie.password }, { "content-type": "application/json" })).json()) as { token: string }).token;
  const curieKey = ((await (await post("/v1/me/keys", { currentPassword: curie.password }, { authorization: `Bearer ${curieSession}`, "content-type": "application/json" })).json()) as { apiKey: string }).apiKey;
  const theirs = { authorization: `Bearer ${curieKey}`, "content-type": "application/json" };
  const own = (await (await send("/v1/me/keys", { headers: theirs })).json()) as {
    keys: { id: string; prefix: string; revokedAt: number | null }[];
  };
  check("you can list your own keys", own.keys.length, 1);
  check("and the row carries nothing secret", Object.keys(own.keys[0] ?? {}).sort(), ["createdAt", "id", "lastUsedAt", "prefix", "revokedAt"]);
  const keyId = own.keys[0]?.id ?? "";
  check("revoking the key you are holding is allowed", (await send(`/v1/me/keys/${keyId}`, { method: "DELETE", headers: theirs })).status, 200);
  check("and it stops authenticating immediately", await outcome(await send("/v1/me", { headers: theirs })), [401, "api_key_revoked"]);
  // Read back as curie's session: the revoked key was curie's only other credential, and no admin route lists it (Q1.631).
  const asCurie = { authorization: `Bearer ${curieSession}`, "content-type": "application/json" };
  const after = (await (await send("/v1/me/keys", { headers: asCurie })).json()) as {
    keys: { revokedAt: number | null }[];
  };
  check("the revoked row is still listed, with its timestamp", [after.keys.length, after.keys[0]?.revokedAt !== null], [1, true]);
  check("a second revoke is a 404", await outcome(await send(`/v1/me/keys/${keyId}`, { method: "DELETE", headers: asCurie })), [404, "key_not_found"]);
  check("and so is revoking it as somebody else's own", await outcome(await send(`/v1/me/keys/${keyId}`, { method: "DELETE", headers: hers })), [404, "key_not_found"]);
  // Read the code, not the status: the already-revoked key made a live route answer 404 too, as key_not_found (Q1.631).
  const vanished = (response: Response): Promise<[number, string]> => outcome(response);
  check("the admin's list of somebody's keys is gone", await vanished(await send(`/v1/admin/users/${curie.id}/keys`, { headers: superAdmin })), [404, "not_found"]);
  check("and so is the admin's revoke of one", await vanished(await send(`/v1/admin/users/${curie.id}/keys/${keyId}`, { method: "DELETE", headers: superAdmin })), [404, "not_found"]);
  check("even aimed at a different account", await vanished(await send(`/v1/admin/users/${bystander.id}/keys/${keyId}`, { method: "DELETE", headers: superAdmin })), [404, "not_found"]);
  const listed = ((await (await send("/v1/admin/users", { headers: superAdmin })).json()) as {
    users: Record<string, unknown>[];
  }).users.find((user) => user["id"] === curie.id);
  check("and the fleet list carries no count of anybody's keys", [listed !== undefined, listed !== undefined && "keys" in listed], [true, false]);
}

// cpctl.ts cannot be imported, since its module body dispatches on argv, so its source is read and its own code run against the real routes.

process.stdout.write("\ncpctl, against the routes it calls\n");
{
  const source = readFileSync(new URL("../packages/control-plane/scripts/cpctl.ts", import.meta.url), "utf8");

  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));

  {
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

    // cpctl key reads no password and cpctl email still asks an API-key caller for one (Q1.630).
    // Read with comments stripped: a comment naming a call would satisfy a positive pin.
    const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const code = stripComments(source);
    const caseOf = (name: string): string => {
      const start = code.indexOf(`case "${name}": {`);
      if (start === -1) throw new Error(`cpctl.ts has no case "${name}"`);
      return code.slice(start, code.indexOf("\n    }\n", start));
    };
    check("cpctl key sends no password, because the route reads none", /currentPasswordBody\(/.test(caseOf("key")), false);
    check("and no body at all", /body:/.test(caseOf("key")), false);
    check("cpctl email still asks for it, because the route asks an API-key caller", /currentPasswordBody\(/.test(caseOf("email")), true);
    const helperAt = code.indexOf("async function currentPasswordBody(");
    const helperBody = code.slice(helperAt, code.indexOf("\n}\n", helperAt));
    check(
      "and the helper sends nothing under a session token, which the route ignores, before it could prompt",
      [
        helperAt !== -1 && /"\/v1\/me"/.test(helperBody),
        /if \(me\.via === "session"\) return JSON\.stringify\(\{\}\);/.test(helperBody),
        helperBody.indexOf('me.via === "session"') < helperBody.indexOf("readSecret("),
      ],
      [true, true, true],
    );
    check("cpctl keys prints when each was last used", /usedText\(key\.lastUsedAt\)/.test(caseOf("keys")), true);
    const usedTextAt = code.indexOf("function usedText(");
    const usedTextBody = code.slice(usedTextAt, code.indexOf("\n}\n", usedTextAt));
    check(
      "with one arm for a key never presented and one for the age",
      [usedTextBody.includes('"never used"'), /last used \$\{/.test(usedTextBody)],
      [true, true],
    );
    const appSource = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
    // The statement form, not the bare table name, so prose naming this rule is not counted.
    const mints = 'db.prepare("INSERT INTO api_keys';
    check("app.ts mints a key in exactly one place", appSource.split(mints).length - 1, 1);
    const mintAt = appSource.indexOf(mints);
    const routeStart = appSource.lastIndexOf("app.post(", mintAt);
    check(
      "and that place is not a route naming somebody else",
      appSource.slice(routeStart, mintAt).includes('c.req.param("id")'),
      false,
    );

    // Handlers under /v1/admin/users/:id, each sliced to its own two-space-indent closer; the helpers count as touching api_keys.
    // The account delete is the one exemption, pinned to a bare sweep (Q1.631).
    const ADMIN_USER_ROUTE = /^  app\.(get|post|put|patch|delete)\("(\/v1\/admin\/users\/:id(?:\/[^"]*)?)"/gm;
    const adminUserRoutes = [...appSource.matchAll(ADMIN_USER_ROUTE)].map((found) => {
      const start = found.index ?? 0;
      const end = appSource.indexOf("\n  });", start);
      return { name: `${found[1]} ${found[2]}`, path: found[2] ?? "", closed: end !== -1, body: appSource.slice(start, end === -1 ? appSource.length : end) };
    });
    // Fewer than six means the pattern stopped matching, and every check below would pass over nothing.
    check("the routes under /v1/admin/users/:id are found", adminUserRoutes.length >= 6, true);
    check("and every handler body ends at a route's own closer", adminUserRoutes.every((route) => route.closed), true);
    check("neither key route is registered any more", adminUserRoutes.filter((route) => route.path.includes("/keys")).map((route) => route.name), []);
    const TOUCHES_KEYS = /api_keys|apiKeyRows|revokeApiKey|touchKey|keyPrefix/;
    check(
      "the one handler under it that touches api_keys is the account delete",
      adminUserRoutes.filter((route) => TOUCHES_KEYS.test(route.body)).map((route) => route.name),
      ["delete /v1/admin/users/:id"],
    );
    const sweep = adminUserRoutes.find((route) => route.name === "delete /v1/admin/users/:id")?.body ?? "";
    check(
      "and it only sweeps — one DELETE, no SELECT or UPDATE on the table, and none of the helpers",
      [
        (sweep.match(/DELETE FROM api_keys WHERE user_id = \?/g) ?? []).length,
        /SELECT[^;]*FROM api_keys/.test(sweep),
        /UPDATE api_keys/.test(sweep),
        /apiKeyRows|revokeApiKey|touchKey|keyPrefix/.test(sweep),
      ],
      [1, false, false, false],
    );
  }

  {
    // A regex, not a literal: app.ts wraps the insert onto the next line and machines.ts does not; prose naming the rule is not counted.
    const appSource = readFileSync(new URL("../packages/control-plane/src/app.ts", import.meta.url), "utf8");
    const machinesSource = readFileSync(new URL("../packages/control-plane/src/machines.ts", import.meta.url), "utf8");
    const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const GRANT_INSERT = /db\.prepare\(\s*"INSERT INTO grants/g;
    // Where each insert sits: the nearest two-space-indent registration above it is its handler.
    const ROUTE_AT = /^  app\.(get|post|put|patch|delete)\("([^"]+)"/gm;
    const registrations = [...appSource.matchAll(ROUTE_AT)].map((found) => ({
      at: found.index ?? 0,
      name: `${found[1]} ${found[2]}`,
    }));
    const routeFor = (at: number): string => {
      let held = "outside every route";
      for (const registration of registrations) {
        if (registration.at > at) break;
        held = registration.name;
      }
      return held;
    };
    const grantWriters = [...appSource.matchAll(GRANT_INSERT)].map((found) => routeFor(found.index ?? 0));
    check("app.ts writes a grant in exactly two places", grantWriters.length, 2);
    check(
      "and machines.ts in exactly one, which is a machine coming into existence",
      (machinesSource.match(GRANT_INSERT) ?? []).length,
      1,
    );
    // One writer is under /v1/admin by design: adoption writes the new owner's grant, behind the two refusals checked below.
    check(
      "and the two are the owner's own share route and the adoption route",
      grantWriters,
      ["put /v1/machines/:id/grants", "put /v1/admin/machines/:id/owner"],
    );
    check(
      "so exactly one grant writer sits under /v1/admin",
      grantWriters.filter((name) => name.slice(name.indexOf(" ") + 1).startsWith("/v1/admin/")),
      ["put /v1/admin/machines/:id/owner"],
    );
    const bodyOfRoute = (registration: string): string => {
      const at = appSource.indexOf(`app.${registration}`);
      if (at === -1) throw new Error(`app.ts no longer registers ${registration}`);
      const end = appSource.indexOf("\n  });", at);
      return stripComments(appSource.slice(at, end === -1 ? appSource.length : end));
    };
    // Stripped: both codes are quoted in the prose above their guards.
    const adoption = bodyOfRoute('put("/v1/admin/machines/:id/owner"');
    const adoptionInsert = adoption.search(GRANT_INSERT);
    check(
      "and it refuses a live owner and an existing grantee before it writes one",
      [
        adoption.indexOf('"machine_owned"') !== -1 && adoption.indexOf('"machine_owned"') < adoptionInsert,
        adoption.indexOf('"machine_granted"') !== -1 && adoption.indexOf('"machine_granted"') < adoptionInsert,
      ],
      [true, true],
    );

    // No await between the ownership check and the insert; only checkable as text, since no request can win that race on demand.
    const sharing = bodyOfRoute('put("/v1/machines/:id/grants"');
    const resolvedAt = sharing.indexOf("ownedMachine(c)");
    const sharingInsert = sharing.search(GRANT_INSERT);
    report(
      "the share handler resolves ownership and then inserts",
      resolvedAt !== -1 && sharingInsert !== -1 && resolvedAt < sharingInsert,
      `ownedMachine at ${resolvedAt}, insert at ${sharingInsert}`,
    );
    check("with no await at all between the two", /await/.test(sharing.slice(resolvedAt, sharingInsert)), false);
    check("because the body it needs is read ahead of the check", /await readJsonObject\(c\)/.test(sharing.slice(0, resolvedAt)), true);

    // The count is parsed from spendWrite's docblock prose and compared to the calls, never written as a literal here.
    const WRITTEN: Record<string, number> = {
      two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    };
    const stated = /There are \*\*([a-z]+)\*\*/.exec(appSource)?.[1] ?? "";
    report("spendWrite's docblock still states its count as a word", stated in WRITTEN, `"${stated}"`);
    check(
      "and that is how many call sites there are",
      (appSource.match(/spendWrite\(c, "/g) ?? []).length,
      WRITTEN[stated],
    );

    // cpctl still names admin grant and ungrant in a refusal, so the pin is that no method goes to that path, not a missing case.
    const cpctlAdmin = stripComments(source.slice(source.indexOf("async function admin(")));
    check(
      "cpctl's admin verbs mention /v1/admin/grants exactly once, for the listing",
      (cpctlAdmin.match(/\/v1\/admin\/grants/g) ?? []).length,
      1,
    );
    check(
      "and send no method with it, which is what a read is",
      /\/v1\/admin\/grants[^;]*method:/.test(cpctlAdmin),
      false,
    );
    check("while the refusal names the verb that replaced them", /cpctl share <machineId> <userId>/.test(cpctlAdmin), true);
    check("and so does the usage text", source.includes("There is no 'admin grant' and no 'admin ungrant'"), true);

    // The verb is lifted out of the daemon's 409 sentence and looked for in the switch, so a reworded daemon sentence is caught.
    const tunnelSource = stripComments(readFileSync(new URL("../src/relay/tunnel.ts", import.meta.url), "utf8"));
    const refusedAt = tunnelSource.indexOf("status === 409");
    const namedVerb = /`cpctl admin ([a-z][a-z-]*) </.exec(refusedAt === -1 ? "" : tunnelSource.slice(refusedAt))?.[1] ?? "";
    report("the daemon's 409 refusal names a cpctl verb", namedVerb.length > 0, `cpctl admin ${namedVerb}`);
    check("and cpctl's admin switch actually has it", cpctlAdmin.includes(`case "${namedVerb}":`), true);
    // Sliced from USAGE, since cpctl.ts spells the verb twice more outside it; both ends are guarded so a missing anchor cannot widen the slice.
    const usageAt = source.indexOf("const USAGE = `");
    const usageEnd = usageAt === -1 ? -1 : source.indexOf("`;", usageAt);
    const usageText = usageEnd === -1 ? "" : source.slice(usageAt, usageEnd);
    report("cpctl's usage text was found to read", usageText.length > 0, `${usageText.split("\n").length} lines`);
    check("and it lists the verb the daemon names", new RegExp(`\\n  admin ${namedVerb} `).test(usageText), true);

    // Swept over sqlite.ts with comments stripped and compared against namedVerb, so two misses never read as agreement.
    const storeSource = stripComments(readFileSync(new URL("../src/store/sqlite.ts", import.meta.url), "utf8"));
    const storeVerbs = [
      ...new Set([...storeSource.matchAll(/`cpctl admin ([a-z][a-z-]*)/g)].map((found) => found[1] ?? "")),
    ];
    report("the daemon's two-live-keys repair names a cpctl verb", storeVerbs.length === 1, storeVerbs.join(", "));
    check("and it is the same verb its 409 names", storeVerbs, [namedVerb]);
  }

  {
    // Field names are compared, not the rendered line: a renamed field renders as an empty string and could not fail.
    const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const code = stripComments(source);
    const armAt = code.indexOf('case "clearkey": {');
    const armEnd = armAt === -1 ? -1 : code.indexOf("\n    }\n", armAt);
    const arm = armAt === -1 || armEnd === -1 ? "" : code.slice(armAt, armEnd);
    report("cpctl's clearkey arm was found to read", arm.length > 0, `${arm.split("\n").length} lines`);

    const declaredIn = /api<\{([^}]*)\}>/.exec(arm)?.[1] ?? "";
    const declared = [...declaredIn.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((found) => found[1] ?? "").sort();
    const reads = [
      ...new Set([...arm.matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((found) => found[1] ?? "")),
    ].sort();
    const branch = /if \(!body\.([A-Za-z_][A-Za-z0-9_]*)\)/.exec(arm)?.[1] ?? "";

    // Cleared twice so the route answers both branches; u_admin gets a fresh key since the original is scoped to its block.
    const machine = addMachine("m_cpctl_clearkey");
    setMachineKey(db, machine, "E".repeat(MAX_MACHINE_KEY_CHARS));
    const adminKey = newApiKey();
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_admin', ?, ?, ?)").run(
      newId("ak"),
      adminKey.prefix,
      adminKey.hash,
      now,
    );
    const headers = { authorization: `Bearer ${adminKey.key}` };
    const path = `/v1/admin/machines/${machine}/machine-key`;
    const first = (await (await send(path, { method: "DELETE", headers })).json()) as Record<string, unknown>;
    const second = (await (await send(path, { method: "DELETE", headers })).json()) as Record<string, unknown>;

    check("the fields cpctl reads off this answer are the fields the route sends", reads, Object.keys(first).sort());
    check("and its cast declares exactly those", declared, reads);
    report("cpctl chooses its whole sentence on one field of that answer", branch.length > 0, `body.${branch}`);
    check(
      "and that field is the one the route flips between its two answers",
      [first[branch], second[branch]],
      [true, false],
    );
  }

  {
    // Anchored on the call, not the sentence, since prose may quote the output; three sessions so a stale field cannot pass.
    const line = source.split("\n").find((text) => text.includes("out(`signed out of"));
    if (line === undefined) throw new Error("cpctl.ts no longer prints a `signed out of` line");
    const template = /`([^`]*)`/.exec(line)?.[1];
    if (template === undefined) throw new Error("cpctl.ts's `signed out of` line is no longer a template literal");
    const render = new Function("body", `return \`${template}\`;`) as (body: unknown) => string;

    const holder = newId("u");
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, 'cpctl-sessions', 0, ?)").run(holder, now);
    const anonymous = { ip: null, userAgent: null };
    const first = mintSession(db, holder, anonymous, null);
    mintSession(db, holder, anonymous, null);
    mintSession(db, holder, anonymous, null);

    const body = await (
      await send("/v1/me/sessions", { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } })
    ).json();
    check("the route answers a count under the name the browser reads", body, { revokedCount: 3 });
    check("and cpctl prints that count rather than `undefined`", render(body), "signed out of 3 session(s)");
  }
}

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
  const between = await Promise.resolve(
    app.request("/v1/tokens", { method: "POST", headers, body: JSON.stringify({ machine: "x".repeat(70 * 1024) }) }),
  );
  check("a body the public limit refuses is fine past the gate", await envelope(between), [404, "machine_not_found"]);
}

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

  check("but no cache directive reaches a JSON answer", mine.headers.get("cache-control"), null);
  check("and no policy is spent on a body that is not a document", mine.headers.get("content-security-policy"), null);

  const bare = await Promise.resolve(app.request("/"));
  check("a browser at the root is refused in the envelope", bare.status, 404);
  check(
    "and told so in JSON rather than in nothing",
    ((await bare.json()) as { error?: { code?: string } }).error?.code,
    "not_found",
  );
  const deep = await Promise.resolve(app.request("/m/m_x/s/s_y"));
  check("as is a deep link a client-side router would own", [deep.status, deep.headers.get("content-type")?.startsWith("application/json")], [404, true]);

  check("health is unaffected by there being no bundle", (await Promise.resolve(app.request("/health"))).status, 200);
  check("and so is the instance document every client boots on", (await Promise.resolve(app.request("/v1/instance"))).status, 200);
}

// Driven against a gate root built here, so the check never skips on a checkout that has not built dist-gate.

process.stdout.write("\nthe gate is served and the app is not\n");
{
  const root = tmp("relaycheck-gate-");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "gate.html"), "<!doctype html><html><body>gate</body></html>");
  writeFileSync(join(root, "assets", "gate-abc123.js"), "export default 1;\n");

  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
    gateRoot: root,
  });
  const get = async (path: string): Promise<[number, string]> => {
    const response = await Promise.resolve(app.request(path));
    return [response.status, (response.headers.get("content-type") ?? "").split(";")[0] ?? ""];
  };

  for (const path of ["/register", "/confirm", "/forgot", "/reset", "/verify"]) {
    check(`${path} is served a page`, await get(path), [200, "text/html"]);
  }
  for (const path of ["/terms", "/acceptable-use", "/privacy"]) {
    check(`${path} is served a page`, await get(path), [200, "text/html"]);
  }
  check("and so is the handoff", await get("/app"), [200, "text/html"]);
  check("the bundle's assets are served", await get("/assets/gate-abc123.js"), [200, "text/javascript"]);

  for (const path of ["/", "/settings", "/new", "/m/m_x/s/s_y", "/p/m_x/board"]) {
    check(`${path} belongs to the app and is refused`, await get(path), [404, "application/json"]);
  }
  check("an unknown path is refused too", await get("/nope"), [404, "application/json"]);
  // 401 rather than 404: callerAuth sits above every private route, so no credential is refused before routing.
  check("an unrouted API path is refused as an API", await get("/v1/nope"), [401, "application/json"]);
  check("and so is /health with a typo, which names no route either", await get("/healthz"), [404, "application/json"]);

  const page = await Promise.resolve(app.request("/register"));
  report(
    "a served page carries the document policy",
    (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    (page.headers.get("content-security-policy") ?? "").slice(0, 48),
  );
  check("and refuses to be framed", page.headers.get("x-frame-options"), "DENY");
  check("and is not cached without revalidation", page.headers.get("cache-control"), "no-cache");
}

// shellQuote alone keeps a caller-influenced Host out of the piped shell; this asserts the route calls it, offline.

process.stdout.write("\nthe installer, with no bundle behind it\n");
{
  const dir = tmp("relaycheck-install-");
  const script = join(dir, "bootstrap.sh");
  writeFileSync(script, "#!/bin/sh\nREEMOAT_CONTROL_PLANE=@REEMOAT_CONTROL_PLANE@\n");
  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
    bootstrapScript: script,
  });

  // A full URL, not a Host header: publicUrl reads the request URL's origin, which a header alone leaves as localhost.
  const served = await Promise.resolve(app.request("http://cp.example/install.sh"));
  const body = await served.text();
  check(
    "an instance with no UI still hands out an installer",
    [served.status, served.headers.get("content-type"), served.headers.get("cache-control")],
    [200, "text/plain; charset=utf-8", "no-store"],
  );
  check("with its own address substituted in", body.includes("'http://cp.example'"), true);
  check("and no placeholder left behind", body.includes("@REEMOAT_CONTROL_PLANE@"), false);

  // The Host reaches URL.origin intact, so quoting is the only thing keeping a hostile Host out of the shell.
  const hostile = await Promise.resolve(app.request("http://a$(id)b/install.sh"));
  check("a hostile Host is quoted rather than refused", (await hostile.text()).includes("'http://a$(id)b'"), true);

  const absent = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relay: registry,
    bootstrapScript: join(dir, "nothing-here.sh"),
  });
  const missing = await Promise.resolve(absent.request("/install.sh"));
  check(
    "a missing script is a 404 rather than a 500",
    [missing.status, ((await missing.json()) as { error?: { code?: string } }).error?.code],
    [404, "not_found"],
  );

  for (const [name, content] of [
    ["none", "#!/bin/sh\necho hi\n"],
    ["two", "#!/bin/sh\nA=@REEMOAT_CONTROL_PLANE@\nB=@REEMOAT_CONTROL_PLANE@\n"],
  ] as const) {
    const path = join(dir, `${name}.sh`);
    writeFileSync(path, content);
    const app2 = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry, bootstrapScript: path });
    const answer = await Promise.resolve(app2.request("/install.sh"));
    check(`a template with ${name} placeholders is refused`, answer.status, 404);
  }

  const none = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const off = await Promise.resolve(none.request("/install.sh"));
  check(
    "and an instance that serves no installer says so in the envelope",
    [off.status, ((await off.json()) as { error?: { code?: string } }).error?.code],
    [404, "not_found"],
  );

  rmSync(dir, { recursive: true, force: true });
}

process.stdout.write("\nwhat a browser is allowed to keep\n");
{
  const webRoot = tmp("relaycheck-gate-");
  mkdirSync(join(webRoot, "assets"));

  const chunk = 'console.log("the bundle");\n';
  writeFileSync(join(webRoot, "assets", "index-abc123.js"), chunk);

  // Over COMPRESS_MIN_BYTES, so the gzip path runs and its content-length is exercised.
  const bundle = `${'console.log("the bundle");\n'.repeat(600)}//# sourceMappingURL=index.js.map\n`;
  writeFileSync(join(webRoot, "assets", "index-big.js"), bundle);

  const buildOne = '<!doctype html><title>one</title><div id="root"></div><script src="/assets/index-abc123.js"></script>\n';
  const buildTwo = '<!doctype html><title>two</title><div id="root"></div><script src="/assets/index-def456.js"></script>\n';
  writeFileSync(join(webRoot, "gate.html"), buildOne);

  const app = createControlPlaneApp({
    db,
    issuer: ISSUER,
    tokenTtlSeconds: 300,
    relayUrl,
    relayUrls: { "relay-2": "https://r2.example" },
    relay: registry,
    gateRoot: webRoot,
  });

  {
    const outcomeOf = async (response: Response): Promise<[number, string]> => [
      response.status,
      ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
    ];
    // Signed in: callerAuth answers an unknown /v1 path with 401 before notFound is reached.
    const nosy = newId("u");
    const nosyKey = newApiKey();
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)").run(nosy, "webroot-nosy", 0, now);
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      nosy,
      nosyKey.prefix,
      nosyKey.hash,
      now,
    );
    const signedIn = { authorization: `Bearer ${nosyKey.key}`, "content-type": "application/json" };

    check(
      "an unknown /v1 path answers this service's envelope, not a page",
      await outcomeOf(await Promise.resolve(app.request("/v1/nope", { headers: signedIn }))),
      [404, "not_found"],
    );
    check(
      "and so does a verb on a route this build deleted",
      await outcomeOf(
        await Promise.resolve(app.request("/v1/admin/grants", { method: "PUT", headers: signedIn, body: "{}" })),
      ),
      [404, "not_found"],
    );
    check(
      "and a method on a path outside /v1 that this build does not serve",
      await outcomeOf(await Promise.resolve(app.request("/settings", { method: "POST" }))),
      [404, "not_found"],
    );
    const deepLink = await Promise.resolve(app.request("/m/m_abc/s/s_def"));
    check(
      "and a client-side route of the app's is refused rather than answered with a page",
      [deepLink.status, (await deepLink.text()).startsWith("<!doctype")],
      [404, false],
    );
  }

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

  {
    const csp = (await Promise.resolve(app.request("/register"))).headers.get("content-security-policy") ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    const base = new URL(relayUrl);
    check("the policy names the default relay, both schemes", [
      connect.includes(base.origin),
      connect.includes(`ws://${base.host}`),
    ], [true, true]);
    check("and every relay in the routing map, or it blocks its own routing", [
      connect.includes("https://r2.example"),
      connect.includes("wss://r2.example"),
    ], [true, true]);

    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? "";
    check(
      "an instance with no catalogue names neither market host, in either directive",
      [connect.includes("raw.githubusercontent.com"), img.includes("raw.githubusercontent.com")],
      [false, false],
    );
    check(
      "and the one model catalogue the picker reads, on an instance with nothing configured",
      [connect.includes("https://openrouter.ai"), img.includes("openrouter.ai")],
      [true, false],
    );
  }

  {
    const withMarket = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      gateRoot: webRoot,
      pluginCatalogueUrl: "https://plugins.example",
    });
    const csp = (await Promise.resolve(withMarket.request("/register"))).headers.get("content-security-policy") ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? "";
    check(
      "a catalogue is reachable, and so is the host its manifests and icons come from",
      [
        connect.includes("https://plugins.example"),
        connect.includes("https://raw.githubusercontent.com"),
        img.includes("https://raw.githubusercontent.com"),
        connect.includes("https://openrouter.ai"),
      ],
      [true, true, true, true],
    );
    const deep = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      gateRoot: webRoot,
      pluginCatalogueUrl: "https://plugins.example/api/v2/",
    });
    const deepCsp = (await Promise.resolve(deep.request("/register"))).headers.get("content-security-policy") ?? "";
    check(
      "and it is listed as an origin rather than as the path it was configured with",
      /connect-src ([^;]+)/.exec(deepCsp)?.[1]?.includes("https://plugins.example/api") ?? true,
      false,
    );
    const nonsense = createControlPlaneApp({
      db,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl,
      relay: registry,
      gateRoot: webRoot,
      pluginCatalogueUrl: "not a url",
    });
    const nonsenseCsp = (await Promise.resolve(nonsense.request("/register"))).headers.get("content-security-policy") ?? "";
    check(
      "an unparseable catalogue widens nothing",
      (/img-src ([^;]+)/.exec(nonsenseCsp)?.[1] ?? "").includes("raw.githubusercontent.com"),
      false,
    );

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

  // A gate address rather than the root: the gate serves a closed list of paths and the root is not on it.
  const gatePath = "/register";

  const root = await get(gatePath);
  check("the gate's page is served at a gate address", { status: root.status, body: root.body }, { status: 200, body: buildOne });
  check("and it revalidates before use", root.cacheControl, "no-cache");

  const asset = await get("/assets/index-abc123.js");
  check("a hashed chunk is served", { status: asset.status, body: asset.body }, { status: 200, body: chunk });
  check("and is kept for a year, immutably", asset.cacheControl, "public, max-age=31536000, immutable");

  const second = await get("/forgot");
  check("every gate address is the same page", second.body, root.body);
  check("and carries the same directive", second.cacheControl, root.cacheControl);

  writeFileSync(join(webRoot, "gate.html"), buildTwo);
  const rebuiltRoot = await get(gatePath);
  const rebuiltSecond = await get("/forgot");
  check("a rebuild under the running process is served", rebuiltRoot.body, buildTwo);
  check("on every gate address, from disk", rebuiltSecond.body, buildTwo);

  const missing = await get("/assets/index-deadbeef.js");
  check("a missing hashed chunk is a 404", missing.status, 404);
  check("and a non-200 is never given a cache directive", missing.cacheControl, null);

  const api = await get("/v1/jwks");
  check("an API response is unaffected", { status: api.status, cacheControl: api.cacheControl }, { status: 200, cacheControl: null });

  const extensionless = await get("/assets/foo");
  check("an extensionless path under /assets/ is a 404, not a page of HTML", extensionless.status, 404);
  check("and carries no cache directive at all", extensionless.cacheControl, null);

  writeFileSync(join(webRoot, "assets", "probe.html"), "<!doctype html><title>probe</title>\n");
  const htmlUnderAssets = await get("/assets/probe.html");
  check("an HTML file under /assets/ really is served", htmlUnderAssets.status, 200);
  check("but it revalidates rather than being kept for a year", htmlUnderAssets.cacheControl, "no-cache");

  rmSync(webRoot, { recursive: true, force: true });
}

process.stdout.write("\nlosing the tunnel\n");
{
  await tunnel.stop();
  await sleep(300);
  check("the machine is reported offline", registry.isOnline(mine), false);

  const refused = await relayFetch("/sessions", tokenFor(alice, mine));
  check("requests fail fast rather than queueing", refused.status, 503);
  // A refused upgrade has no body, so refuseUpgrade puts the code on the status line.
  check("with a code that says which kind of unreachable", refused.body, "no_tunnel");

  const again = RelayTunnel.start({
    relayUrl,
    tunnelKey: myTunnelKey,
    local: { host: "127.0.0.1", port: daemonPort },
    // A reconnecting daemon serves nothing without these: the only stream mode is
    // `Noise_IK`, so "no machine key" and "no remote access" are one state.
    staticKey: localStaticKey(mineStatic.secretKey),
    verifier: mineVerifier,
  });
  check("a daemon can reconnect", await waitForTunnel(mine), true);
  check("and serve again", (await relayFetch("/sessions", tokenFor(alice, mine))).status, 200);
  await again.stop();
}

process.stdout.write("\na daemon that takes the stream and never answers\n");
{
  // A parked h2 session: a real RelayTunnel answers the stream before touching loopback, so it cannot reach this state.
  const wedgedMachine = addMachine("m_wedged");
  grant(alice, wedgedMachine);

  const impatient = new TunnelRegistry();
  const impatientListener = createRelayListener({
    db,
    issuer: ISSUER,
    host: "127.0.0.1",
    port: 0,
    registry: impatient,
    channelTimeoutMs: 200,
  });
  await listening(impatientListener.server);
  const impatientPort = (impatientListener.server.address() as AddressInfo).port;

  // A real h2 server, not a bare PassThrough: without SETTINGS the handshake never completes and the case would measure the registry.
  const toWedged = new PassThrough();
  const fromWedged = new PassThrough();
  const wedgedServer = createH2Server();
  wedgedServer.on("stream", (stream) => {
    // Accepted and held. No `respond`, no `end`, no reset — deliberately.
    stream.on("error", () => {});
  });
  wedgedServer.emit("connection", Duplex.from({ readable: toWedged, writable: fromWedged }));
  const parked = h2connect("http://tunnel", {
    createConnection: () => Duplex.from({ readable: fromWedged, writable: toWedged }),
  });
  parked.on("error", () => {});
  impatient.register(
    new EndpointTunnel(wedgedMachine, Date.now(), RELAY_PROTOCOL_VERSION, parked, () => parked.destroy()),
    CLOSE_TUNNEL_SUPERSEDED,
  );
  check("the wedged daemon's tunnel is up", impatient.isOnline(wedgedMachine), true);

  const started = Date.now();
  const held = await new Promise<number>((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${impatientPort}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(tokenFor(alice, wedgedMachine))}`,
    );
    ws.on("open", () => {
      ws.terminate();
      resolve(0);
    });
    ws.on("unexpected-response", (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on("error", () => resolve(-1));
    setTimeout(() => resolve(-2), 5_000).unref();
  });
  const waited = Date.now() - started;
  check("a channel it never answers is given up on", held, 504);
  report("rather than held until the client gives up", waited < 3_000, `${waited}ms`);
  report("and as a status rather than as an opaque close", held > 0, `HTTP ${held}`);

  impatientListener.close();
  parked.destroy();
  wedgedServer.close();
}

// A link is one person's two machines: a 90-day capability minted by the target's Authority, bound to the source's pinned key (Q7.150).

process.stdout.write("\nlinks between machines one person owns\n");
{
  const app = createControlPlaneApp({ db, issuer: ISSUER, tokenTtlSeconds: 300, relayUrl, relay: registry });
  const send = (path: string, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.request(path, init));
  const outcome = async (response: Response): Promise<[number, string]> => [
    response.status,
    ((await response.json()) as { error?: { code?: string } }).error?.code ?? "ok",
  ];

  const person = (name: string): { id: string; headers: Record<string, string> } => {
    const id = newId("u");
    const key = newApiKey();
    db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(id, name, now);
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      newId("ak"),
      id,
      key.prefix,
      key.hash,
      now,
    );
    return { id, headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" } };
  };
  const owner = person("linker");
  const grantee = person("linkgrantee");
  const loner = person("linkloner");

  // Acquisition order is the rank order the limit reads, so each machine's place below is deliberate.
  let acquired = now;
  const own = (
    who: string,
    label: string,
    options: { enrolled?: boolean; key?: string | null; revoked?: boolean; granted?: boolean } = {},
  ): string => {
    const id = newId("m");
    acquired += 1;
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at, revoked_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      `${label}-${id}`,
      acquired,
      options.enrolled === false ? null : acquired,
      options.revoked === true ? acquired : null,
    );
    if (options.key !== null) {
      setMachineKey(db, id, options.key ?? Buffer.from(generateStaticKey().publicKey).toString("base64url"));
    }
    db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      who,
      label,
      acquired,
    );
    if (options.granted !== false) {
      db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
        who,
        id,
        "session:read session:write machine:admin",
        acquired,
      );
    }
    return id;
  };

  const sourceStatic = generateStaticKey();
  const targetStatic = generateStaticKey();
  const keyOf = (pair: { publicKey: Uint8Array }): string => Buffer.from(pair.publicKey).toString("base64url");
  const target = own(owner.id, "link-target", { key: keyOf(targetStatic) });
  const offline = own(owner.id, "link-offline");
  const source = own(owner.id, "link-source", { key: keyOf(sourceStatic) });
  const unenrolled = own(owner.id, "link-unenrolled", { enrolled: false });
  const keyless = own(owner.id, "link-keyless", { key: null });
  const revoked = own(owner.id, "link-revoked", { revoked: true });
  const ungranted = own(owner.id, "link-ungranted", { granted: false });
  const newest = own(owner.id, "link-newest");
  own(loner.id, "alone");
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
    grantee.id,
    source,
    "session:read session:write machine:admin",
    now,
  );

  interface MintedLink {
    id: string;
    token: string;
    expiresAt: number;
    target: { id: string; name: string; key: string; relayUrl: string | null };
  }
  const mintLinks = async (machine: string, who = owner): Promise<Response> =>
    send(`/v1/machines/${machine}/links`, { method: "POST", headers: who.headers });
  const linksFrom = async (machine: string): Promise<MintedLink[]> =>
    ((await (await mintLinks(machine)).json()) as { links: MintedLink[] }).links;
  const payloadOf = (token: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

  check("a machine somebody only holds a grant on is not theirs to link from", await outcome(await mintLinks(source, grantee)), [
    404,
    "machine_not_found",
  ]);
  check("nor is one that does not exist", await outcome(await mintLinks("m_nothing")), [404, "machine_not_found"]);
  check("a machine that has not enrolled has nothing to link", await outcome(await mintLinks(unenrolled)), [
    409,
    "machine_not_enrolled",
  ]);
  check("nor does one with no pinned key, since a link is bound to it", await outcome(await mintLinks(keyless)), [
    409,
    "machine_key_missing",
  ]);
  check("a revoked one is refused as revoked", await outcome(await mintLinks(revoked)), [403, "machine_revoked"]);
  check(
    "an owner with one machine is answered an empty list rather than a refusal",
    await (await mintLinks(`alone`, loner)).json(),
    { links: [] },
  );

  const minted = await linksFrom(source);
  check(
    "a link is minted to every other machine that is enrolled, keyed, live, granted and within the limit",
    minted.map((link) => link.target.id),
    [target, offline, newest],
  );
  // Each is owned by the caller, so leaving it out is the eligibility filter's doing and not ownership's.
  check(
    "and not to one unenrolled, keyless, revoked or with no grant for its owner",
    [unenrolled, keyless, revoked, ungranted].filter((id) => minted.some((link) => link.target.id === id)),
    [],
  );
  check(
    "each target named as its owner names it, with the key it must answer as",
    minted[0]?.target,
    { id: target, name: "link-target", key: keyOf(targetStatic), relayUrl },
  );
  check("and a link id of its own shape", minted.every((link) => /^lk_[0-9a-f]{16}$/.test(link.id)), true);

  const claims = payloadOf(minted[0]?.token ?? "");
  check("the capability carries these claims and no others", Object.keys(claims).sort(), [
    "aud",
    "cnf",
    "exp",
    "iat",
    "iss",
    "jti",
    "lnk",
    "nbf",
    "scp",
    "src",
    "srcl",
    "sub",
  ]);
  check("one scope, which no grant stores", claims["scp"], ["session:message"]);
  check(
    "bound to the source machine's pinned key, not to any device",
    claims["cnf"],
    { jkt: jwkThumbprint(x25519Jwk(sourceStatic.publicKey)) },
  );
  check(
    "naming the link, the source and the source's label",
    [claims["lnk"], claims["src"], claims["srcl"]],
    [minted[0]?.id, source, "link-source"],
  );
  check("for the target, on the owner's authority", [claims["aud"], claims["sub"], claims["iss"]], [target, owner.id, ISSUER]);
  check("living ninety days", [LINK_TOKEN_TTL_SECONDS, Number(claims["exp"]) - Number(claims["iat"])], [7_776_000, 7_776_000]);
  report(
    "from now",
    Math.abs(Number(claims["iat"]) - Date.now() / 1000) < 5,
    `iat ${String(claims["iat"])} against ${Math.floor(Date.now() / 1000)}`,
  );
  check("and the answer's expiresAt is the same instant", minted[0]?.expiresAt, Number(claims["exp"]) * 1000);

  const rowsFor = (machine: string): number =>
    Number(db.prepare("SELECT COUNT(*) AS n FROM machine_links WHERE source_machine_id = ?").get(machine)?.["n"] ?? -1);
  const again = await linksFrom(source);
  check("asking again finds the same links", again.map((link) => link.id), minted.map((link) => link.id));
  check("rather than writing new rows", rowsFor(source), 3);
  report(
    "with a freshly minted capability for each",
    again.every((link, i) => payloadOf(link.token)["jti"] !== payloadOf(minted[i]?.token ?? "")["jti"]),
    "every jti differs",
  );
  check(
    "and a machine is found by its owner's label as well as its id",
    (await linksFrom("link-source")).map((link) => link.id),
    minted.map((link) => link.id),
  );

  writeMachineLimit(db, owner.id, 7, "u_admin");
  check(
    "a target past its owner's limit is left out",
    (await linksFrom(source)).map((link) => link.target.id),
    [target, offline],
  );
  writeMachineLimit(db, owner.id, 2, "u_admin");
  check("and a source past it is refused", await outcome(await mintLinks(source)), [403, "machine_over_limit"]);
  clearMachineLimit(db, owner.id);

  const listed = async (machine: string, who = owner): Promise<Response> =>
    send(`/v1/machines/${machine}/links`, { headers: who.headers });
  type ListedLink = { id: string; source: { id: string; name: string }; target: { id: string; name: string } };
  // Sorted: links minted in one request share a created_at, and their ids are random.
  const pairs = async (machine: string): Promise<string[]> =>
    ((await (await listed(machine)).json()) as { links: ListedLink[] }).links
      .map((link) => `${link.source.name}>${link.target.name}`)
      .sort();
  const fromTarget = await linksFrom(target);
  check(
    "the other machine links back with links of its own",
    fromTarget.map((link) => link.target.id),
    [offline, source, newest],
  );
  check("a machine's links are listed in both directions", await pairs(source), [
    "link-source>link-newest",
    "link-source>link-offline",
    "link-source>link-target",
    "link-target>link-source",
  ]);
  check("and only to its owner", await outcome(await listed(source, grantee)), [404, "machine_not_found"]);
  db.prepare("UPDATE machines SET revoked_at = ? WHERE id = ?").run(Date.now(), newest);
  check(
    "a link to a machine since revoked is not listed",
    (await pairs(source)).includes("link-source>link-newest"),
    false,
  );
  db.prepare("UPDATE machines SET revoked_at = NULL WHERE id = ?").run(newest);

  // Authorize alone first: every refusal of a link's own is the unknown machine's 404.
  const authorizer = createRelayAuthorizer(db, ISSUER);
  const toTarget = minted[0]!;
  const toOffline = minted[1]!;
  const forged = (overrides: Record<string, unknown>): string => {
    const seconds = Math.floor(Date.now() / 1000);
    const base: Record<string, unknown> = {
      iss: ISSUER,
      sub: owner.id,
      aud: target,
      jti: newId("t"),
      iat: seconds,
      nbf: seconds,
      exp: seconds + 300,
      scp: ["session:message"],
      cnf: { jkt: jwkThumbprint(x25519Jwk(sourceStatic.publicKey)) },
      lnk: toTarget.id,
      src: source,
      srcl: "link-source",
    };
    return signToken({ ...base, ...overrides } as unknown as TokenClaims, signing.kid, signing.privateKey);
  };
  const decided = (token: string): unknown => {
    const answer = authorizer.authorize(token);
    return answer.ok ? { subject: answer.subject, limiter: answer.limiter } : [answer.status, answer.code];
  };

  check("a link's capability is authorized on its own share, stamped with its owner", decided(toTarget.token), {
    subject: owner.id,
    limiter: { key: `lnk:${toTarget.id}`, max: MAX_STREAMS_PER_LINK, link: true },
  });
  check("while a person's is counted against theirs", decided(tokenFor(owner.id, target)), {
    subject: owner.id,
    limiter: { key: owner.id, max: MAX_STREAMS_PER_SUBJECT, link: false },
  });
  check("a link naming another source than its row's is refused as no machine", decided(forged({ src: offline })), [
    404,
    "machine_not_found",
  ]);
  // The owner holds a grant on `offline`, so the only thing wrong with this one is the row.
  check("and one aimed at another target than its row's", decided(forged({ aud: offline })), [404, "machine_not_found"]);
  check("and a link that does not exist", decided(forged({ lnk: "lk_0000000000000000" })), [404, "machine_not_found"]);
  check(
    "a link claim without its source is malformed rather than an ordinary capability",
    [decided(forged({ src: undefined })), decided(forged({ srcl: undefined })), decided(forged({ lnk: 7 }))],
    [
      [401, "malformed_token"],
      [401, "malformed_token"],
      [401, "malformed_token"],
    ],
  );

  db.prepare("UPDATE machines SET revoked_at = ? WHERE id = ?").run(Date.now(), source);
  check("a source since revoked is refused as no machine", decided(toTarget.token), [404, "machine_not_found"]);
  db.prepare("UPDATE machines SET revoked_at = NULL WHERE id = ?").run(source);

  // `source` is the owner's third acquisition, so a limit of two switches it off and leaves the target on.
  writeMachineLimit(db, owner.id, 2, "u_admin");
  check("a source past its owner's limit is refused as no machine", decided(toTarget.token), [404, "machine_not_found"]);
  check("while its owner still reaches the target", (decided(tokenFor(owner.id, target)) as { subject?: string }).subject, owner.id);
  clearMachineLimit(db, owner.id);

  db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(Date.now(), owner.id);
  check("and a source whose owner is banned", decided(toTarget.token), [404, "machine_not_found"]);
  db.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(owner.id);

  // Through the shipped relay, to the target's real tunnel end, which checks `cnf` against the handshake.
  const targetTunnel = RelayTunnel.start({
    relayUrl,
    tunnelKey: issueTunnelKey(db, target),
    local: { host: "127.0.0.1", port: daemonPort },
    staticKey: localStaticKey(targetStatic.secretKey),
    verifier: new SignedTokenVerifier({
      identity: { machineId: target, issuer: ISSUER, keys: activePublicKeys(db) },
    }),
  });
  check("the target's tunnel is up", await waitForTunnel(target), true);
  const asSource = { secretKey: sourceStatic.secretKey, remoteStatic: targetStatic.publicKey };

  {
    const before = proxied(target);
    const through = await relayFetch("/sessions", toTarget.token, asSource);
    check("a link's capability opens a channel to its target, from the source machine's key", through.status, 200);
    report("down the target's tunnel", proxied(target) - before === 1, `${proxied(target) - before} streams`);
    const stolen = await relayFetch("/sessions", toTarget.token, { remoteStatic: targetStatic.publicKey });
    check(
      "and from any other key it is refused at the target, because cnf names the source",
      [stolen.status, stolen.body],
      [401, "wrong_device"],
    );
    check(
      "while the owner's own capability reaches the same machine",
      (await relayFetch("/sessions", tokenFor(owner.id, target), { remoteStatic: targetStatic.publicKey })).status,
      200,
    );
  }

  // Held open without a handshake: the relay's stream lives as long as the socket, which is what a share counts.
  const holdChannel = (port: number, token: string): Promise<{ status: number | "open"; ws: WebSocket }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(token)}`);
      ws.on("open", () => resolve({ status: "open", ws }));
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate();
        resolve({ status: res.statusCode ?? 0, ws });
      });
      ws.on("error", () => resolve({ status: 0, ws }));
    });
  const refusedWith = (port: number, token: string): Promise<{ status: number; line: string; headers: Record<string, unknown> }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_CHANNEL_PATH}?token=${encodeURIComponent(token)}`);
      ws.on("open", () => {
        ws.terminate();
        resolve({ status: 101, line: "open", headers: {} });
      });
      ws.on("unexpected-response", (_req, res) => {
        ws.terminate();
        resolve({ status: res.statusCode ?? 0, line: res.statusMessage ?? "", headers: res.headers });
      });
      ws.on("error", () => resolve({ status: 0, line: "(no channel)", headers: {} }));
    });

  {
    const held = await Promise.all(Array.from({ length: MAX_STREAMS_PER_LINK }, () => holdChannel(relayPort, toTarget.token)));
    check("a link holds its whole share of the target's tunnel", held.map((one) => one.status), Array(MAX_STREAMS_PER_LINK).fill("open"));
    const past = await refusedWith(relayPort, toTarget.token);
    check("and is refused one channel past it", [past.status, past.line], [503, "no_tunnel"]);
    const fromOffline = (await linksFrom(offline)).find((link) => link.target.id === target)!;
    const second = await holdChannel(relayPort, fromOffline.token);
    check("while another link to the same machine still opens", second.status, "open");
    check(
      "and the owner's own capability too",
      (await relayFetch("/sessions", tokenFor(owner.id, target), { remoteStatic: targetStatic.publicKey })).status,
      200,
    );
    for (const one of [...held, second]) one.ws.terminate();
    const settled = Date.now() + 2_000;
    while (Date.now() < settled && activeStreams(target) !== 0) await sleep(25);
    check("and every one of those streams is given back", activeStreams(target), 0);
  }

  {
    // `offline` holds no tunnel, so every open below is a cheap 503 and the only thing that can change is the budget.
    const started = Date.now();
    const burst: number[] = [];
    for (let i = 0; i < LINK_CONNECT_BURST; i += 1) burst.push((await refusedWith(relayPort, toOffline.token)).status);
    const over = await refusedWith(relayPort, toOffline.token);
    const elapsed = Date.now() - started;
    check("a link opens a burst of channels, even at a machine that is offline", burst, Array(LINK_CONNECT_BURST).fill(503));
    report(
      "and the one past the burst inside a second is refused as too fast",
      over.status === 429 && over.line === "link_rate_limited",
      `${over.status} ${over.line} after ${elapsed}ms`,
    );
    check("saying when to ask again", over.headers["retry-after"], String(Math.ceil(LINK_CONNECT_REFILL_MS / 1000)));
    check(
      "while its owner, on the same machine, is charged nothing",
      (await refusedWith(relayPort, tokenFor(owner.id, offline))).line,
      "no_tunnel",
    );
    check("and another link spends a budget of its own", (await relayFetch("/sessions", toTarget.token, asSource)).status, 200);
  }

  {
    const unlink = (id: string, who = owner): Promise<Response> =>
      send(`/v1/links/${id}`, { method: "DELETE", headers: who.headers });
    check("somebody who owns neither end cannot remove a link", await outcome(await unlink(toTarget.id, grantee)), [
      404,
      "link_not_found",
    ]);
    check("nor can anybody remove one that does not exist", await outcome(await unlink("lk_0000000000000000")), [
      404,
      "link_not_found",
    ]);
    const removed = await unlink(toTarget.id);
    check("its owner removes it, with nothing to say", [removed.status, await removed.text()], [204, ""]);
    check("and removing it again is the same answer, so a retry is safe", (await unlink(toTarget.id)).status, 204);
    check("it is no longer listed", (await pairs(source)).includes("link-source>link-target"), false);

    const before = proxied(target);
    const refused = await relayFetch("/sessions", toTarget.token, asSource);
    check("and the relay refuses its next channel as no machine", [refused.status, refused.body], [404, "machine_not_found"]);
    report("before it reached the tunnel", proxied(target) === before, `requestsProxied stayed at ${before}`);
    check(
      "while the owner's own capability still reaches the machine",
      (await relayFetch("/sessions", tokenFor(owner.id, target), { remoteStatic: targetStatic.publicKey })).status,
      200,
    );
    const relinked = (await linksFrom(source)).find((link) => link.target.id === target);
    report(
      "asking again makes a new link rather than reviving the old one",
      relinked !== undefined && relinked.id !== toTarget.id,
      `${toTarget.id} then ${relinked?.id ?? "none"}`,
    );
    check(
      "which the relay lets through",
      (await relayFetch("/sessions", relinked?.token ?? "", asSource)).status,
      200,
    );
  }

  await targetTunnel.stop();

  // Several relays: the one a daemon dialled holds no tunnel for this machine, and says which one does.
  {
    const siblingRegistry = new TunnelRegistry();
    const siblingListener = createRelayListener({
      db,
      issuer: ISSUER,
      host: "127.0.0.1",
      port: 0,
      registry: siblingRegistry,
      siblings: { view: dbRelayView(db), urls: { "relay-2": "https://r2.example" }, relayId: "relay-1" },
    });
    await listening(siblingListener.server);
    const siblingPort = (siblingListener.server.address() as AddressInfo).port;
    const elsewhere = createPresenceWriter(db, { relayId: "relay-2" });
    elsewhere.up(offline, Date.now());

    const redirected = await refusedWith(siblingPort, tokenFor(owner.id, offline));
    check("a machine a sibling relay holds is answered 421", [redirected.status, redirected.line], [421, "wrong_relay"]);
    check("naming where that relay is reached", redirected.headers[RELAY_URL_HEADER], "https://r2.example");
    const linkRedirect = await refusedWith(siblingPort, toOffline.token);
    check("and a link is sent the same way", [linkRedirect.status, linkRedirect.headers[RELAY_URL_HEADER]], [
      421,
      "https://r2.example",
    ]);
    check(
      "but never before the capability is authorized, or it would say where any machine is",
      (await refusedWith(siblingPort, tokenFor(mallory, offline))).status,
      404,
    );
    check(
      "and never by a relay with no map of its siblings",
      (await refusedWith(relayPort, tokenFor(owner.id, offline))).line,
      "no_tunnel",
    );

    const stray = createPresenceWriter(db, { relayId: "relay-9" });
    stray.up(offline, Date.now() + 1);
    check(
      "a relay the map does not name is no_tunnel rather than a redirect to nowhere",
      (await refusedWith(siblingPort, tokenFor(owner.id, offline))).line,
      "no_tunnel",
    );
    const itself = createPresenceWriter(db, { relayId: "relay-1" });
    itself.up(offline, Date.now() + 2);
    check(
      "and a row naming this relay is a tunnel it has just lost, never a sibling",
      (await refusedWith(siblingPort, tokenFor(owner.id, offline))).line,
      "no_tunnel",
    );

    for (const writer of [elsewhere, stray, itself]) writer.clear();
    siblingListener.close();
  }
}

// While the shared relay is still up: it starts two daemons of its own against it.
await peerEndToEnd({ db, issuer: ISSUER, relayUrl, registry, check, waitForTunnel });

relayListener.close();
daemon.close();

process.stdout.write("\nthe SMTP client, against a fake server\n");
{
  interface FakeSmtpOptions {
    /** Capability lines per EHLO, in order. The last is reused if asked again. */
    ehlo: string[][];
    /** Replies that override the default, keyed by the start of the command. */
    refuse?: Record<string, string>;
    /** Handed the ordinary upgrade, so a case can decline to settle at all. */
    startTls?: (upgrade: () => Duplex) => Promise<Duplex | null>;
    quitCuts?: boolean;
  }

  interface FakeSmtp {
    dialer: SmtpDialer;
    /** Command lines only — the DATA body is not commands and is not here. */
    written: string[];
  }

  /**
   * A server that answers a script and records every command line.
   * Two PassThroughs, since one would echo the client's writes back; the EHLO counter is shared across the upgrade.
   */
  const fakeSmtp = (options: FakeSmtpOptions): FakeSmtp => {
    const written: string[] = [];
    const open: PassThrough[] = [];
    let ehloAt = 0;
    // AUTH LOGIN progress: 0 none, 1 expecting the username, 2 expecting the password.
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

  {
    const fake = fakeSmtp({ ehlo: [["SIZE 10240000"]] });
    const failure = await refusal(deliver(fake.dialer, { auth: "plain", username: "u", password: "p" }));
    check("a server that does not offer STARTTLS is refused at the right step", failure?.step, "starttls");
    check("and nothing at all was written past the EHLO", fake.written, ["EHLO [127.0.0.1]"]);
    check(
      "so no credential and no recipient reached a cleartext wire",
      fake.written.some((line) => /^(AUTH|MAIL FROM)/i.test(line)),
      false,
    );
  }

  {
    const fake = fakeSmtp({ ehlo: [["STARTTLS"], ["AUTH PLAIN"]] });
    const failure = await refusal(deliver(fake.dialer, { auth: "plain", username: "u", password: "p" }));
    report(
      "a server advertising AUTH only after TLS is authenticated against",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    const secondEhlo = fake.written.lastIndexOf("EHLO [127.0.0.1]");
    const auth = fake.written.findIndex((line) => line.toUpperCase().startsWith("AUTH"));
    report(
      "and the AUTH followed the second EHLO rather than the first",
      secondEhlo > 0 && auth > secondEhlo,
      fake.written.join(" · "),
    );
  }

  {
    const fake = fakeSmtp({ ehlo: [["STARTTLS"], []], quitCuts: true });
    const failure = await refusal(deliver(fake.dialer));
    report(
      "a QUIT that dies after the final 250 is not a failed send",
      failure === null,
      failure === null ? "delivered" : `${failure.step}: ${failure.message}`,
    );
    check("and the QUIT really was attempted", fake.written.includes("QUIT"), true);
  }

  {
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

  {
    const stuck = fakeSmtp({
      ehlo: [["STARTTLS"], []],
      startTls: () => new Promise<Duplex | null>(() => undefined),
    });
    const started = Date.now();
    // Raced rather than awaited, so a handshake that never settles reddens a line instead of hanging the driver.
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

  {
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
    check("the password is never on the command line", /AUTH LOGIN .+/.test(fake.written[at] ?? ""), false);
  }

  {
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

  {
    const fake = fakeSmtp({ ehlo: [["AUTH PLAIN"]] });
    const failure = await refusal(
      deliver(fake.dialer, { security: "plaintext", auth: "plain", username: "u", password: "p" }),
    );
    check("a password over an unencrypted connection is refused at auth", failure?.step, "auth");
    check("and nothing past the EHLO was written", fake.written, ["EHLO [127.0.0.1]"]);
    check("and the refusal is ours rather than a server's", [failure?.code, failure?.permanent], [null, false]);
  }

  {
    check("CR, LF and tabs collapse to one space", sanitizeReply("550 no\r\n\tand no"), "550 no and no");
    check("other control characters go entirely", sanitizeReply("550 \x00\x07ok\x7f"), "550 ok");
    check("and the result is trimmed", sanitizeReply("  \r\n 550 ok \r\n "), "550 ok");
    const long = sanitizeReply("x".repeat(1000));
    // 300 characters plus the ellipsis.
    check("an over-long reply is truncated visibly", [long.length, long.endsWith("…")], [301, true]);
  }
}

process.stdout.write("\nthe SMTP client, over a real TLS socket\n");
{
  // Loopback-only test fixture, self-signed for localhost and 127.0.0.1; it signs nothing and nothing trusts it.
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

  /** Enough SMTP for one send; `greet` is false on the upgraded stream, where a second 220 would be read as the reply to the second EHLO. */
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
          // STARTTLS is offered only before the upgrade and AUTH only after, like a careful server.
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
  /** A send through the real dialer: null on success, the error otherwise. */
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
          timeouts: { connect: 5_000, greeting: 5_000, ehlo: 5_000, starttls: 5_000, handshake: 5_000, total: 20_000 },
        },
        envelope,
      );
      return null;
    } catch (error) {
      return error instanceof SmtpError ? error : new SmtpError("body", `not an SmtpError: ${String(error)}`);
    }
  };

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
    check(`and ${host} spoke the whole conversation`, secureState.written, [
      "EHLO [127.0.0.1]",
      `AUTH PLAIN ${Buffer.from("\0ada@example.com\0a mailbox password", "utf8").toString("base64")}`,
      "MAIL FROM:<bot@example.com>",
      "RCPT TO:<ada@example.com>",
      "DATA",
      "QUIT",
    ]);
  }

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

  {
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

  {
    const odb = fresh();
    const id = enqueueMail(odb, queued);
    check("a queued message has an id", typeof id, "string");
    const claimed = claimNextMail(odb, Date.now());
    check("and is claimable exactly once", [claimed?.id === id, claimed?.attempts], [true, 1]);
    check("a second claim at the same instant gets nothing", claimNextMail(odb, Date.now()), null);

    recordMailSent(odb, String(id));
    const row = rowOf(odb, String(id));
    check("recording a send marks it sent", row["sent_at"] !== null, true);
    check("and drops the live link in the same statement", row["body"], null);
    odb.close();
  }

  {
    const odb = fresh();
    const id = String(enqueueMail(odb, queued));
    const claimed = claimNextMail(odb, Date.now());
    if (claimed === null) throw new Error("the row this case is about was not claimable");
    recordMailFailure(odb, claimed, new SmtpError("mail_from", "refused", 550, "550 5.1.8 no"));
    const row = rowOf(odb, id);
    check("a permanent refusal is terminal at once", [row["failed_at"] !== null, row["last_error"]], [
      true,
      "mail_from: refused",
    ]);
    check("and the body goes with it", row["body"], null);

    const health = mailHealth(odb);
    check(
      "a failure is counted and its own words are kept",
      [health.failed, health.pending, health.lastError],
      [1, 0, "mail_from: refused"],
    );
    report("and it is stamped", health.lastFailedAt !== null, `lastFailedAt: ${String(health.lastFailedAt)}`);
    odb.close();
  }

  // TLS and socket text is not a server reply, so nothing sanitized it on the way in; the row is where it must be.
  {
    const odb = fresh();
    const hostile = `unable to verify the first certificate\r\nX-Injected: yes\r\n${"z".repeat(2000)}`;
    const flat = "unable to verify the first certificate X-Injected: yes zzz";
    let connectFailure: unknown = null;
    try {
      await sendMessage(
        {
          host: "fake.example",
          port: 465,
          security: "implicit_tls",
          auth: "none",
          username: null,
          password: null,
          rejectUnauthorized: true,
          ehloName: "[127.0.0.1]",
          dialer: { connect: () => Promise.reject(new Error(hostile)) },
        },
        { from: "bot@example.com", to: "ada@example.com", message: "Subject: hi\r\n\r\nbody\r\n" },
      );
    } catch (error) {
      connectFailure = error;
    }
    const cases: [string, unknown, string, number][] = [
      // What socketDialer's startTls rejects with.
      ["a TLS failure", new SmtpError("starttls", `TLS failed: ${hostile}`), `starttls: TLS failed: ${flat}`, 1],
      ["a connect failure", connectFailure, `connect: could not reach fake.example:465: ${flat}`, 1],
      // Terminal, so it is the row the admin banner reads.
      ["a throw that is not an SmtpError", new Error(hostile), flat, Number.MAX_SAFE_INTEGER],
    ];
    for (const [what, error, prefix, attempts] of cases) {
      const id = String(enqueueMail(odb, queued));
      const claimed = claimNextMail(odb, Date.now());
      if (claimed === null) throw new Error("the row this case is about was not claimable");
      recordMailFailure(odb, { ...claimed, attempts }, error);
      const stored = String(rowOf(odb, id)["last_error"] ?? "");
      check(
        `${what} is stored on one line and bounded like a reply`,
        [stored.startsWith(prefix), /[\r\n]/.test(stored), stored.length <= sanitizeReply(hostile).length],
        [true, false, true],
      );
    }
    check("and the banner shows it the same way", mailHealth(odb).lastError, sanitizeReply(hostile));
    odb.close();
  }

  {
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

  {
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

  // Full jitter at 0.5 is a multiplier of exactly 1.0, so this walks the flat curve.
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

  {
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

  {
    // The dialer connects and then says nothing, so the greeting timeout (ten seconds) fires; the second send proves the pump released running.
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
          ?
            Promise.resolve({
              stream: new PassThrough(),
              startTls: () => Promise.resolve(null),
              close(): void {
                // Nothing to tear down.
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
    // The step is read off the row: the event carries only the message.
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

process.stdout.write("\na message as bytes, and an address as a string\n");
{

  {
    // Fifteen four-byte emoji need two encoded-words, the smallest subject where slicing bytes would split a character.
    const subject = "🙂".repeat(15);
    const encoded = encodeWord(subject);
    const words = [...encoded.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)].map((match) => match[1] ?? "");
    report("a long emoji subject needs more than one encoded-word", words.length >= 2, `${words.length} words`);
    check(
      "and every word decodes on its own back into the whole subject",
      words.map((word) => Buffer.from(word, "base64").toString("utf8")).join(""),
      subject,
    );
    const longest = Math.max(...encoded.split("\r\n ").map((word) => word.length));
    report("no word is longer than RFC 2047 allows", longest <= 75, `${longest} characters`);
  }

  {
    let threw = false;
    try {
      headerSafe("Subject", "a\r\nBcc: x@y");
    } catch {
      threw = true;
    }
    check("a header value carrying a CRLF is refused rather than cleaned up", threw, true);
  }

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
    check("every line ends CRLF, with no bare LF anywhere", /[^\r]\n/.test(built), false);
    check(
      "and no line begins with a dot, because both parts are base64",
      built.split("\r\n").some((line) => line.startsWith(".")),
      false,
    );
    check("dot-stuffing still doubles a leading dot on every line", dotStuff(".a\r\n.b\r\nc"), "..a\r\n..b\r\nc");
    check("the date is the one this document is supposed to carry", /^Date: Thu, 01 Jan 1970 00:00:00 \+0000$/m.test(built), true);
  }

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
    check("but a trailing newline is trimmed off and accepted", checkEmailAddress("a@b\n"), {
      ok: true,
      address: "a@b",
      folded: "a@b",
    });
    check("an ordinary address is accepted", checkEmailAddress("Ada@example.com").ok, true);
    check("and so is an intranet domain with no dot at all", checkEmailAddress("ada@intranet").ok, true);
  }

  {
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

process.stdout.write("\nsettings, and where each value came from\n");
{
  const sdb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(sdb);

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
    check("and clearing the override hands the environment back", readSetting(sdb, key), {
      value: "env.example",
      source: "environment",
    });
    delete process.env[variable];
    check("with neither, it is unset rather than empty", readSetting(sdb, key), { value: null, source: "unset" });

    if (held === undefined) delete process.env[variable];
    else process.env[variable] = held;
  }

  {
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
    check("an empty optional address is not malformed", checkSettingValue("mail.reply_to", ""), null);
  }

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

process.stdout.write("\nthe three startup sweeps\n");
{
  const sweepDb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(sweepDb);
  const at = Date.now();
  const HOUR = 60 * 60 * 1000;

  {
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

  {
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
    // Its own database: sweeping the rows above a second time would answer 0 whatever the predicate.
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

  {
    const LONG_AGO = 30 * 24 * HOUR;
    const insert = sweepDb.prepare(
      "INSERT INTO mail_outbox (id,to_address,to_folded,kind,subject,body,created_at,not_after,next_at,attempts,sent_at,failed_at) " +
        "VALUES (?,?,?,'reset','Reset your password','{\"text\":\"https://cp.example/reset#t=ut_livetoken\"}',?,?,?,0,?,?)",
    );
    insert.run("mo_sent_old", "a@e", "a@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null);
    insert.run("mo_failed_old", "b@e", "b@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null, at - LONG_AGO);
    insert.run("mo_sent_now", "c@e", "c@e", at, at + HOUR, at, at, null);
    insert.run("mo_stalled_old", "d@e", "d@e", at - LONG_AGO, at - LONG_AGO, at - LONG_AGO, null, null);
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
    check(
      "the row that never reached any state at all went with them",
      sweepDb.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE id = 'mo_stalled_old'").get()?.["n"],
      0,
    );
    check("and a second pass finds nothing", pruneMailOutbox(sweepDb, at), 0);
  }

  sweepDb.close();
}

process.stdout.write("\nregistration, recovery, and the mail that carries them\n");
{
  const gdb = new DatabaseSync(":memory:");
  applyControlPlaneSchema(gdb);
  ensureSigningKey(gdb);

  const mailed: EnqueueArgs[] = [];
  // Also writes the outbox row: sentRecently and the MAX_OUTBOX_PENDING refusal read mail_outbox, not this array.
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

  /** The forgot route answers first and queues its mail afterwards, so yield once before reading what it mailed. */
  const settled = (): Promise<void> => new Promise((resolve) => setImmediate(() => resolve()));

  check(
    "registration is closed unless somebody opened it",
    ((await (await gget("/v1/instance")).json()) as { registration: { enabled: boolean } }).registration.enabled,
    false,
  );

  // AGPL §13 source offer, on the unauthenticated response; app.ts holds the version as a literal, so this is its drift check.
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

  // Public routes sit above the positional 256 KiB limit, so each needs its own bodyLimit.
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
    // No acceptedTerms above: an instance that has not claimed the documents may not refuse a sign-up for them (Q1.638).
    check(
      "an instance publishing no documents says so on the wire",
      ((await (await gget("/v1/instance")).json()) as { legal?: { documents?: unknown } }).legal?.documents,
      false,
    );
  }

  {
    // Its own database: registering moves the sign-up throttle that later sections read.
    const ldb = new DatabaseSync(":memory:");
    applyControlPlaneSchema(ldb);
    ensureSigningKey(ldb);
    writeSetting(ldb, "registration.enabled", "true", null);
    const claimed = createControlPlaneApp({
      db: ldb,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl: "ws://relay.invalid",
      legalDocuments: true,
    });
    const cpost = (path: string, body: unknown): Promise<Response> =>
      Promise.resolve(
        claimed.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    check(
      "a deployment that has claimed them says so",
      ((await (await claimed.request("/v1/instance")).json()) as { legal?: { documents?: unknown } }).legal?.documents,
      true,
    );
    check(
      "and it refuses a sign-up that agreed to nothing",
      await codeOf(await cpost("/v1/register", { name: "grace", password: "correct horse battery" })),
      [400, "terms_not_accepted"],
    );
    check(
      "a truthy value that is not true is not agreement",
      await codeOf(
        await cpost("/v1/register", { name: "grace", password: "correct horse battery", acceptedTerms: "yes" }),
      ),
      [400, "terms_not_accepted"],
    );
    check(
      "and it takes one that did",
      (await cpost("/v1/register", { name: "grace", password: "correct horse battery", acceptedTerms: true })).status,
      201,
    );
    // Consent is deliberately not recorded; a consent column appearing here is a changed decision (Q7.134).
    const columns = ldb
      .prepare("SELECT name FROM pragma_table_info('users')")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    check("and stored nothing about it", columns.filter((name) => /terms|consent|accepted/i.test(name)), []);
  }

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
    check("and a token can never look like a filename", /\./.test(token), false);

    const done = await gpost("/v1/register/confirm", { token });
    const doneBody = await done.text();
    check(
      "confirming creates the account",
      [done.status, (JSON.parse(doneBody) as { user: { name: string } }).user.name],
      [201, "carol"],
    );
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

  {
    const first = await gpost("/v1/register", {
      name: "pavel",
      password: "correct horse battery",
      email: "contested@example.com",
    });
    check("a first sign-up on a contested address is pending", first.status, 200);
    const pavelsLink = tokenOf("register");

    const second = await gpost("/v1/register", {
      name: "rupert",
      password: "correct horse battery",
      email: "contested@example.com",
    });
    check("a different name on the same address is answered the same silent way", second.status, 200);
    const rupertsLink = tokenOf("register");
    check(
      "and it mints its own link rather than re-mailing somebody else's",
      rupertsLink !== pavelsLink && rupertsLink.length > 0,
      true,
    );
    check(
      "the first link is still live, so the second did not supersede it",
      (await gpost("/v1/register/confirm", { token: pavelsLink })).status,
      201,
    );
    check(
      "and the mailbox having chosen, the loser's link fails on the address",
      await codeOf(await gpost("/v1/register/confirm", { token: rupertsLink })),
      [409, "email_taken"],
    );
  }

  {
    const squat = await gpost("/v1/register", {
      name: "Cased",
      password: "the squatter's own password",
      email: "cased@example.com",
    });
    check("a squatter's sign-up under a capitalised name is pending", squat.status, 200);
    const squattersLink = tokenOf("register");

    const owner = await gpost("/v1/register", {
      name: "cased",
      password: "the mailbox owner's password",
      email: "cased@example.com",
    });
    check(
      "the mailbox owner signing up as themselves is refused rather than handed the squatter's row",
      await codeOf(owner),
      [409, "name_taken"],
    );
    check("and nothing new was mailed to them", tokenOf("register"), squattersLink);
  }

  // 401 rather than 404: an unregistered path falls to the positional gate, which fails closed.
  check(
    "the resend route is gone, and gone from the public set with it",
    await codeOf(await gpost("/v1/register/resend", { email: "erin@example.com" })),
    [401, "missing_api_key"],
  );

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
    check("and the real owner is warned instead", mailed.slice(before).map((m) => m.kind), ["register_notice"]);
    check("at their address, never the asker's", mailed.at(-1)?.to, "carol@example.com");
    check("and the notice never names the account", /carol/.test(mailed.at(-1)?.text ?? ""), false);
  }

  {
    const before = mailed.length;
    const unknown = await gpost("/v1/forgot", { email: "nobody@example.com" });
    const known = await gpost("/v1/forgot", { email: "carol@example.com" });
    check("an unknown address and a known one answer identically", await unknown.text(), await known.text());
    await settled();
    check("but only one of them queued anything", mailed.length - before, 1);
    check("and it was the reset", mailed.at(-1)?.kind, "reset");

    const token = tokenOf("reset");
    check(
      "a weak password is refused",
      await codeOf(await gpost("/v1/reset", { token, newPassword: "short" })),
      [400, "weak_password"],
    );
    const set = await gpost("/v1/reset", { token, newPassword: "a whole new password" });
    check("and the link still works afterwards", set.status, 200);
    check("it reports the keys rather than silently sweeping them", ((await set.json()) as { apiKeysActive: number }).apiKeysActive, 0);
    check(
      "spending it twice is refused",
      await codeOf(await gpost("/v1/reset", { token, newPassword: "another whole password" })),
      [409, "token_unusable"],
    );
  }

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

  {
    const made = (await (await gpost("/v1/admin/users", { name: "erin", email: "erin@example.com" }, op)).json()) as {
      id: string;
    };
    const token = tokenOf("invite");
    await gpost(`/v1/admin/users/${made.id}/disable`, {}, op);
    check(
      "a banned account's outstanding link is dead",
      (await gpost("/v1/reset", { token, newPassword: "erins own password" })).status !== 200,
      true,
    );
  }

  {
    const raw = await (await gget("/v1/admin/settings", op)).text();
    // The whole response is searched: a per-field check would miss a leak through envValue.
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

    // mail.public_url is https://cp.example here, and gapp was built with no gate bundle.
    {
      const gateRoot = tmp("relaycheck-gate-");
      writeFileSync(join(gateRoot, "gate.html"), "<!doctype html><html><body>gate</body></html>");
      const gated = createControlPlaneApp({
        db: gdb,
        issuer: ISSUER,
        tokenTtlSeconds: 300,
        relayUrl: "ws://relay.invalid",
        gateRoot,
      });
      const mailFrom = async (
        target: typeof gapp,
        url: string,
      ): Promise<{ configured: boolean; aboutPublicUrl: string[] }> => {
        const mail = ((await (await target.request(url, { headers: op })).json()) as {
          mail: { configured: boolean; problems: string[] };
        }).mail;
        return { configured: mail.configured, aboutPublicUrl: mail.problems.filter((p) => p.startsWith("mail.public_url")) };
      };
      check(
        "a control plane serving its gate takes its own origin as where mailed links go",
        await mailFrom(gated, "https://cp.example/v1/admin/settings"),
        { configured: true, aboutPublicUrl: [] },
      );
      const unbuilt = await mailFrom(gapp, "https://cp.example/v1/admin/settings");
      check(
        "one running without it warns, without stopping mail",
        [unbuilt.configured, unbuilt.aboutPublicUrl.length, /is not set|browser UI/.test(unbuilt.aboutPublicUrl.join(""))],
        [true, 1, false],
      );
      check(
        "and says nothing of an origin that is not its own",
        await mailFrom(gapp, "https://elsewhere.example/v1/admin/settings"),
        { configured: true, aboutPublicUrl: [] },
      );
      rmSync(gateRoot, { recursive: true, force: true });
    }

    const keysNow = async (): Promise<{ kid: string; retiredAt: number | null }[]> =>
      ((await (await gget("/v1/admin/signing-keys", op)).json()) as {
        keys: { kid: string; retiredAt: number | null }[];
      }).keys;

    const before = await keysNow();
    check("an instance starts with one active key", before.filter((key) => key.retiredAt === null).length, 1);

    const lonely = await gapp.request(`/v1/admin/signing-keys/${before[0]?.kid ?? "k_none"}`, {
      method: "DELETE",
      headers: op,
    });
    check("the only active key cannot be retired", await codeOf(lonely), [409, "last_active"]);

    const minted = await gpost("/v1/admin/signing-keys", {}, op);
    check("minting a second one is a 201", minted.status, 201);
    const after = await keysNow();
    check("and both are active, which is what makes the overlap survivable", after.filter((key) => key.retiredAt === null).length, 2);
    const published = ((await (await gget("/v1/jwks")).json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
    check("both public halves are handed out", published.length, 2);
    report(
      "with the newest first, which is the one that signs",
      published[0] === after.find((key) => key.retiredAt === null)?.kid,
      `jwks: ${published.join(", ")}`,
    );

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

    // Shape only: manufacturing a failure would pollute the database later sections read.
    const delivery = (JSON.parse(raw) as { mail: { delivery?: Record<string, unknown> } }).mail.delivery;
    check(
      "delivery health rides the same object as the configuration",
      delivery === undefined
        ? "absent"
        : [typeof delivery["pending"], typeof delivery["failed"], typeof delivery["paused"]].join(","),
      "number,number,boolean",
    );
  }

  {
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

  {
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

  {
    const raw = await (await gget("/v1/admin/mail", op)).text();
    const log = JSON.parse(raw) as { total: number; deliveries: Record<string, unknown>[] };
    report("there is something in the log to leak", log.deliveries.length > 0, `${log.total} deliveries`);
    check("no row carries a body", log.deliveries.some((row) => "body" in row), false);
    // The quoted key rather than the bare word, which a real subject line in this log contains.
    check("and no such key appears anywhere in the response", raw.includes('"body"'), false);
    check(
      "and somebody who is not an admin cannot read it",
      await codeOf(await gget("/v1/admin/mail", seedKey(seedUser("u_looker", "looker", null, false)))),
      [403, "forbidden"],
    );
  }

  {
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

  {
    const started = Date.now();
    const answer = await gpost("/v1/admin/settings/test", { to: "ops@example.com" }, op);
    check(
      "a test message is queued rather than sent",
      [answer.status, mailed.at(-1)?.kind, mailed.at(-1)?.to],
      [202, "test", "ops@example.com"],
    );
    report("and the route answered without waiting for a socket", Date.now() - started < 1_000, `${Date.now() - started}ms`);
  }

  {
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

  {
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

  {
    // Repointing the address: a session needs nothing, an API key on an account with a password must present it (Q1.630, Q1.403).
    const pia = seedUser("u_pia", "pia", null, false);
    const piaPassword = "pia's own long password";
    gdb
      .prepare("INSERT INTO user_passwords (user_id, hash, updated_at) VALUES (?,?,?)")
      .run(pia, await hashPassword(piaPassword, "authenticated"), Date.now());
    const piaKey = seedKey(pia);
    const piaSession = {
      authorization: `Bearer ${mintSession(gdb, pia, { ip: null, userAgent: null }, null).token}`,
      "content-type": "application/json",
    };

    check(
      "an API key on an account with a password is refused without it",
      await codeOf(await gput("/v1/me/email", { email: "pia@example.com" }, piaKey)),
      [400, "bad_request"],
    );
    check(
      "and refused with the wrong one, as the password route refuses it",
      await codeOf(await gput("/v1/me/email", { email: "pia@example.com", currentPassword: "not it" }, piaKey)),
      [401, "invalid_password"],
    );
    check(
      "and a refusal wrote no address",
      gdb.prepare("SELECT COUNT(*) AS n FROM user_emails WHERE user_id = ?").get(pia)?.["n"],
      0,
    );
    check(
      "and mailed nothing",
      mailed.filter((m) => m.to === "pia@example.com").length,
      0,
    );
    check(
      "with the right one it goes through",
      (await gput("/v1/me/email", { email: "pia@example.com", currentPassword: piaPassword }, piaKey)).status,
      200,
    );
    check(
      "a session adds or changes the address alone (Q1.630 stands for a person signed in)",
      (await gput("/v1/me/email", { email: "pia2@example.com" }, piaSession)).status,
      200,
    );
    check(
      "and a password in a session's body is ignored, not verified",
      (await gput("/v1/me/email", { email: "pia3@example.com", currentPassword: "not it" }, piaSession)).status,
      200,
    );

    const wren = seedUser("u_wren", "wren", null, false);
    check(
      "an account with no password row is still let through on its key alone",
      (await gput("/v1/me/email", { email: "wren@example.com" }, seedKey(wren))).status,
      200,
    );
  }

  {
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

  {
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

  {
    // One past the threshold: the attempt that trips the block is itself allowed.
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

  {
    seedUser("u_juno", "juno", "juno@example.com", true);
    await gpost("/v1/forgot", { email: "juno@example.com" });
    await settled();
    const live = tokenOf("reset");

    let blocked = false;
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE.threshold; attempt += 1) {
      await gpost("/v1/reset", { token: live, newPassword: "short" });
      const [status] = await codeOf(
        await gpost("/v1/reset", { token: `et_${"z".repeat(24)}${attempt}`, newPassword: "a fine long password" }),
      );
      if (status === 429) blocked = true;
    }
    check("replaying a live link does not un-spend the guessing counter", blocked, true);
    // Read off the row: the address is blocked by now, so spending the link cannot succeed.
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

  {
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

  {
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
    check("an address outside the allowlist is refused", await codeOf(refusedDomain), [400, "bad_request"]);
    check("indistinguishably from one that is not an address", await codeOf(refusedShape), await codeOf(refusedDomain));
    check(
      "and the refusal names no domain",
      /example\.(org|net)/i.test(
        ((await refusedDomain.clone().json()) as { error?: { message?: string } }).error?.message ?? "",
      ),
      false,
    );

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
    // Reset, or later register cases run under this allowlist.
    clearSetting(gdb, "registration.email_domains");
  }

  {
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

  {
    const stuck = createControlPlaneApp({
      db: gdb,
      issuer: ISSUER,
      tokenTtlSeconds: 300,
      relayUrl: "ws://relay.invalid",
      mail: {
        enqueue: () => "mo_stuck",
        wake: () => {
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

  const machine = (id: string, name: string, revoked: boolean): void => {
    fdb.prepare("INSERT INTO machines (id, name, created_at, revoked_at) VALUES (?, ?, ?, ?)")
      .run(id, name, at, revoked ? at : null);
  };
  machine("m_cur", "current", false);
  machine("m_quiet", "quiet", false);
  machine("m_gone", "gone", true);
  machine("m_behind", "behind", false);
  recordDaemonBuild(fdb, "m_cur", {
    daemonVersion: "1.2.3",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    agentClis: "claude=2.1.259;codex=0.153.1;kimi=-",
    at,
  });
  recordDaemonBuild(fdb, "m_gone", { daemonVersion: "0.0.1", protocolVersion: RELAY_PROTOCOL_VERSION, agentClis: null, at });
  recordDaemonBuild(fdb, "m_behind", {
    daemonVersion: "0.9.0",
    protocolVersion: RELAY_PROTOCOL_VERSION - 1,
    agentClis: null,
    at,
  });

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
  // A dash in the reported CLI list is a binary that would not say its version, read back as null.
  check(
    "and the CLI builds it would launch, as of the same dial",
    byId.get("m_cur")?.agents,
    { claude: "2.1.259", codex: "0.153.1", kimi: null },
  );
  check("a machine that said nothing about its CLIs answers null, not an empty list", byId.get("m_gone")?.agents, null);
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
    { [String(RELAY_PROTOCOL_VERSION)]: 1, [String(RELAY_PROTOCOL_VERSION - 1)]: 1, unknown: 1 },
  );
  check("a machine behind reports the protocol it agreed", byId.get("m_behind")?.protocol, RELAY_PROTOCOL_VERSION - 1);
  check(
    "and is counted under it, not folded into the current one",
    [body.byProtocol[String(RELAY_PROTOCOL_VERSION - 1)], body.byProtocol[String(RELAY_PROTOCOL_VERSION)]],
    [1, 1],
  );

  fdb.close();
}

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
