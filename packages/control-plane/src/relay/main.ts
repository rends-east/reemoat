#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { describeError } from "../../../../src/http.js";
import { openControlStore, type ControlStore } from "../store.js";
import { createRelayListener, RELAY_HEALTH_PATH } from "./listener.js";
import {
  claimRelayId,
  createPresenceWriter,
  DEFAULT_RELAY_ID,
  PRESENCE_FLUSH_INTERVAL_MS,
  RELAY_CLAIM_STALE_MS,
  releaseRelayId,
} from "./presence.js";
import { newId } from "../keys.js";
import { TunnelRegistry } from "./registry.js";

/**
 * The relay's entry point — the second deployment of this package.
 *
 * It exists because the two halves of the control plane have opposite restart
 * costs. The API's inputs move constantly (a web bundle, a route, a mail
 * template) and recreating it is ordinary; the relay's move rarely, and
 * recreating *it* costs every tunnel in the fleet: tens of seconds of
 * reconnecting per open session, every in-flight request, and any approval
 * tapped in the window. In one process the cheap deploy paid the expensive
 * price, every time.
 *
 * What this process is: a listener, an in-memory map of tunnels, four read
 * queries against the same SQLite file the API owns, and one table it writes so
 * the API can see what it is carrying. What it deliberately is **not**: it does
 * not mint a signing key (`ensureSigningKey` is the API's, and a second minter
 * would be a race over the one secret in this system), does not bootstrap an
 * admin, does not prune, does not send mail, and holds no private key at all —
 * `authorize` reads `public_jwk` and nothing else.
 *
 * It also does not depend on the API being up. That is not an accident of
 * packaging: authorization is four live row reads, so a control plane that is
 * down stops you *minting* a token and does not stop an existing one reaching
 * your machine.
 */

const DEFAULT_RELAY_HOST = "0.0.0.0";
const DEFAULT_RELAY_PORT = 7889;
const DEFAULT_DB = join(homedir(), ".reemoat", "control-plane.db");
const DEFAULT_ISSUER = "reemoat-cp";

const relayHost = process.env["REEMOAT_CP_RELAY_HOST"] ?? DEFAULT_RELAY_HOST;
const relayPort = Number.parseInt(process.env["REEMOAT_CP_RELAY_PORT"] ?? String(DEFAULT_RELAY_PORT), 10);
if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
  console.error(`REEMOAT_CP_RELAY_PORT must be a valid port, got "${process.env["REEMOAT_CP_RELAY_PORT"]}"`);
  process.exit(2);
}

/*
 * The issuer, which must match the API's or nothing verifies.
 *
 * Same default and same env name, read from the same file both services are
 * given, so the ordinary case needs nobody to think about it. A mismatch is not
 * silent: every token fails `iss` and the relay answers 401, which is loud in
 * the way a wrong shared secret should be.
 */
const issuer = (process.env["REEMOAT_CP_ISSUER"] ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER;

/*
 * This relay's name in `relay_tunnels` — a slot, not a process.
 *
 * A relay that is killed hard cannot delete its own rows, so its replacement
 * clears them by this name at boot. That only works while the name survives a
 * restart, which is why it is a fixed default and not a pid or a container id.
 */
const relayId = (process.env["REEMOAT_CP_RELAY_ID"] ?? DEFAULT_RELAY_ID).trim() || DEFAULT_RELAY_ID;

const dbPath = resolveDbPath(process.env["REEMOAT_CP_DB"]);

let store: ControlStore;
try {
  store = openControlStore({ path: dbPath });
} catch (error) {
  console.error(
    `could not open ${dbPath}: ${describeError(error)}\n` +
      "  Set REEMOAT_CP_DB to a writable path. The relay reads users, machines and grants\n" +
      "  from the same file the control plane owns, so both services must see one volume.",
  );
  process.exit(2);
}

/*
 * The slot, claimed before anything is written to it.
 *
 * ⚠ **Two relays under one `REEMOAT_CP_RELAY_ID` delete each other's rows every
 * five seconds** — `sweep` removes rows carrying this name that this relay's own
 * flush did not stamp, which is every machine on the other one. The fleet flaps
 * between reachable and offline and nothing anywhere says why. `deploy/RELAYS.md`
 * warned about it; a warning in a document is not an enforcement, and this is
 * the same lesson `claimDaemonLock` learned one package over.
 *
 * Before `presence.clear()`, deliberately: that call deletes every row under this
 * name, and doing it while another relay is live would blank the fleet's presence
 * on the way to being told the name was taken.
 */
const nonce = newId("ri");
const claim = claimRelayId(store.db, relayId, nonce);
if (!claim.ok) {
  console.error(
    `another relay already owns the id "${relayId}" on this database ` +
      `(last seen ${Math.round(claim.lastSeenMsAgo / 1000)}s ago).\n` +
      "  Two relays under one id delete each other's presence rows every 5s, so the\n" +
      "  fleet flaps between reachable and offline. Give this one its own\n" +
      "  REEMOAT_CP_RELAY_ID — and its own entry in REEMOAT_CP_RELAY_URLS, or the\n" +
      "  machines it holds fall back to the shared relay name. See deploy/RELAYS.md.\n" +
      `  If that relay is gone rather than running, this clears itself ` +
      `${Math.ceil(RELAY_CLAIM_STALE_MS / 1000)}s after its last heartbeat.`,
  );
  process.exit(2);
}

const presence = createPresenceWriter(store.db, {
  relayId,
  nonce,
  onEvent: (event, detail) => console.error(`relay: ${event} ${detail}`),
});

/*
 * Before the listener, not after.
 *
 * Whatever the previous relay under this name left behind is a lie the moment
 * this process starts — those tunnels died with it. Clearing first means the
 * window in which the API can read a stale `true` ends at boot rather than at
 * the first flush, and the first daemon to dial in writes its own row a moment
 * later.
 */
presence.clear();

/*
 * `relayId` passed to the registry as well as to the writer, and the two must be
 * the same value: the writer stamps it into `relay_tunnels.relay_id`, and
 * `relayFor` is what the API reads back to decide where to send a browser. Two
 * sources for one name is how a fleet ends up routing to a relay that never
 * claimed the tunnel.
 */
const tunnels = new TunnelRegistry(
  (event, detail) => console.error(`relay: ${event} ${detail}`),
  presence,
  relayId,
);

const relay = createRelayListener({
  db: store.db,
  issuer,
  host: relayHost,
  port: relayPort,
  registry: tunnels,
  presence,
  onEvent: (event, detail) => console.error(`relay: ${event} ${detail}`),
  onListenError: (error) => {
    const detail = error.code === "EADDRINUSE" ? " — already in use" : "";
    console.error(`relay: cannot listen on ${relayHost}:${relayPort}${detail}`);
    console.error("set REEMOAT_CP_RELAY_PORT to a free port");
    process.exit(2);
  },
});

relay.server.once("listening", () => {
  console.log(`Reemoat relay listening on http://${relayHost}:${relayPort}`);
  console.log(`issuer: ${issuer}`);
  console.log(`relay id: ${relayId}`);
  console.log(`state: ${dbPath} (read for authorization, presence written every ${PRESENCE_FLUSH_INTERVAL_MS}ms)`);
  console.log(`health: ${RELAY_HEALTH_PATH}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});

/**
 * A backstop, not a licence — and the argument is stronger here than it was in
 * `main.ts`, because this process holds *only* tunnels.
 *
 * Exiting on one stray socket error takes every machine in the fleet offline and
 * makes every daemon reconnect into nothing until a supervisor intervenes. There
 * is nothing else in this process for a bad exception to be corrupting: no
 * credential is minted here, no mail is sent, and the one table it writes is
 * best-effort and re-derived from memory every few seconds.
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
  /*
   * `relay.close()` reaches `registry.closeAll` through the tunnel endpoint, and
   * that is what deletes the presence rows — so a *planned* stop also stops the
   * API reporting these machines as online, rather than leaving them claimed for
   * a staleness window. A hard kill has no such courtesy, which is exactly what
   * the window and the boot-time clear are for.
   */
  relay.close();
  /*
   * The slot goes back on the way out, so an ordinary deploy reclaims the name
   * instantly rather than waiting out `RELAY_CLAIM_STALE_MS`. A hard kill has no
   * such courtesy — which is exactly what that window is for, the same trade the
   * boot-time `presence.clear()` already makes about tunnel rows.
   */
  releaseRelayId(store.db, relayId, nonce);
  store.close();
  console.error("stopped");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** Same rule as `main.ts`: absolute or `:memory:`, never relative to the cwd. */
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
