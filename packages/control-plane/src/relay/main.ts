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

// The relay's own entry point: restarting it costs every tunnel, so it deploys apart from the API.
// It mints no signing key, prunes nothing, sends no mail and holds no private key.

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

// Must match the API's issuer, or every token fails iss with a 401.
const issuer = (process.env["REEMOAT_CP_ISSUER"] ?? DEFAULT_ISSUER).trim() || DEFAULT_ISSUER;

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

// Claimed before presence.clear: two relays under one id sweep each other's rows, and clearing first would blank a live relay's.
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

// Cleared before listening: the previous relay's tunnels died with it.
presence.clear();

// One relayId for the registry and the writer: relayFor must name what the writer stamps.
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

// Continue: this process holds only tunnels, and exiting would take the whole fleet offline.
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
  // Reaches registry.closeAll, which deletes this relay's presence rows on a planned stop.
  relay.close();
  // Released on the way out, so a deploy reclaims the name at once.
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
