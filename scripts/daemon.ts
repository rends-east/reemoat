#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { serve } from "@hono/node-server";
import {
  CompositeVerifier,
  SharedSecretVerifier,
  SignedTokenVerifier,
  enrollmentIgnored,
  type TokenVerifier,
} from "../src/auth.js";
import type { AgentId } from "../src/acp/agents.js";
import { systemSecretFor } from "../src/acp/systems.js";
import { AgentAskRuns } from "../src/agentask.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import { AgentInstallRuns } from "../src/agentinstall.js";
import { AgentScriptGate } from "../src/agentscript.js";
import { AgentUpdates, agentChannelFrom, agentSourceFrom } from "../src/agentupdate.js";
import { announcedControlPlane, removeAnnounce, writeAnnounce, ANNOUNCE_VERSION } from "../src/announce.js";
import { IdleParking } from "../src/idlepark.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { resolveRoots } from "../src/browse.js";
import { codeFingerprint, enroll, EnrollError } from "../src/enroll.js";
import { boundedInt } from "../src/http.js";
import { atOrUnder, expandHome, resolveStateRoot } from "../src/paths.js";
import {
  IDLE_PARK_MS,
  MAX_LIVE_SESSIONS,
  SESSION_CREATE_BURST,
  SESSION_CREATE_REFILL_MS,
  SessionRegistry,
  TURN_SILENCE_MS,
  type WorktreePolicy,
} from "../src/registry.js";
import { RelayTunnel, announcedAgentClis } from "../src/relay/tunnel.js";
import { createApp } from "../src/server.js";
import { localStaticKey } from "@reemoat/protocol";
import { ensureMachineKey, machineKeyRotation } from "../src/machinekey.js";
import { openStores, type StoreBundle, type StoredIdentity } from "../src/store/sqlite.js";
import { Contributions } from "../src/plugins/contributions.js";
import { PluginHost } from "../src/plugins/host.js";
import { PeerHub } from "../src/peers/hub.js";
import { PeerMcpEndpoint } from "../src/peers/mcp.js";
import { createPeerNetwork } from "../src/peers/links.js";
import { resolveUploadRoot, Uploads } from "../src/uploads.js";
import { DEFAULT_BRANCH_PREFIX, resolveWorktreeRoot } from "../src/worktree.js";

const DEFAULT_PORT = 7887;

// libuv reads this once, lazily, so it must be set before any threadpool work; the shell exports it too, the only placement that cannot be outrun.
process.env["UV_THREADPOOL_SIZE"] ??= "64";

function threadpoolNote(): string {
  const configured = (process.env["UV_THREADPOOL_SIZE"] ?? "").trim();
  const size = Number(configured);
  if (Number.isInteger(size) && size > 0) return `threadpool: ${size}`;
  return (
    "threadpool: 4 (default) — UV_THREADPOOL_SIZE is unset.\n" +
    "  Every fs call shares those 4 slots and a stalled network mount holds one for ever."
  );
}

// Loopback: every request arrives down the relay tunnel, spliced to a fresh loopback connection. Port 0 suits a relay-only daemon (Q7.148).
const DEFAULT_HOST = "127.0.0.1";
const SHUTDOWN_HARD_LIMIT_MS = 25_000;

/** The enrollment code was refused: the only failure a fresh code fixes. */
const EXIT_CODE_REFUSED = 3;

/** The control plane could not be reached or did not answer. Wait, do not re-mint. */
const EXIT_CONTROL_PLANE_UNREACHABLE = 4;

/** The OS refused a connection on this network: nothing is down, somebody has to grant a permission. See localNetworkBlocked. */
const EXIT_LOCAL_NETWORK_BLOCKED = 5;

// Every default below derives from this root; the desktop app sets one per server.
let stateHome: string;
try {
  stateHome = resolveStateRoot(process.env["REEMOAT_HOME"]);
} catch (error) {
  console.error(describe(error));
  process.exit(2);
}
const DEFAULT_DB = join(stateHome, "reemoat.db");
const DAY_MS = 86_400_000;

const authMode = resolveAuthMode(process.env["REEMOAT_AUTH"]);

const token = process.env["REEMOAT_TOKEN"];
if (authMode !== "signed" && (!token || token.length === 0)) {
  console.error(
    "REEMOAT_TOKEN is not set.\n" +
      "The daemon exposes agent sessions over the network and refuses to start without a token.\n" +
      "  export REEMOAT_TOKEN=$(openssl rand -hex 16)\n" +
      "Or run against a control plane instead with REEMOAT_AUTH=signed.",
  );
  process.exit(2);
}
if (authMode === "signed" && token && token.length > 0) {
  console.error(
    "warning: REEMOAT_AUTH=signed, so REEMOAT_TOKEN is ignored — the shared secret is not accepted.",
  );
}

const port = Number.parseInt(process.env["REEMOAT_PORT"] ?? String(DEFAULT_PORT), 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`REEMOAT_PORT must be a valid port, or 0 to be assigned one, got "${process.env["REEMOAT_PORT"]}"`);
  process.exit(2);
}
const host = process.env["REEMOAT_HOST"] ?? DEFAULT_HOST;

const roots = resolveRoots(process.env["REEMOAT_ROOTS"]);

if ((process.env["REEMOAT_USER_ROOT"] ?? "").trim().length > 0) {
  console.error(
    "warning: REEMOAT_USER_ROOT is set and no longer does anything.\n" +
      "  Agents run as this user, on this filesystem. Sessions and worktrees under\n" +
      "  that path belong to the multi-tenant layout and are not read. Use\n" +
      "  REEMOAT_ROOTS to choose where browsing starts.",
  );
}
const deadContainerVars = [
  "REEMOAT_CONTAINER_IMAGE",
  "REEMOAT_CONTAINER_HOME",
  "REEMOAT_CONTAINER_USER",
  "REEMOAT_CONTAINER_MEMORY",
  "REEMOAT_CONTAINER_CPUS",
  "REEMOAT_CONTAINER_PIDS",
  "REEMOAT_MAX_CONTAINERS",
].filter((key) => (process.env[key] ?? "").trim().length > 0);
if (deadContainerVars.length > 0) {
  console.error(
    `warning: ${deadContainerVars.join(", ")} set and ignored — agents no longer run in containers.`,
  );
}

const instanceId = `i_${randomBytes(4).toString("hex")}`;
const startedAt = Date.now();
const dbPath = resolveDbPath(process.env["REEMOAT_DB"]);

// Strict at startup: never fall back to a memory store after durability was asked for.
let stores: StoreBundle;
try {
  stores = openStores({
    path: dbPath,
    instanceId,
    // These must stay under the outbound queue bound in server.ts.
    maxEventsPerSession: positiveInt(process.env["REEMOAT_LOG_EVENTS"]),
    maxBytesPerSession: positiveInt(process.env["REEMOAT_LOG_BYTES"]),
    retainSessionsMs: (positiveInt(process.env["REEMOAT_SESSION_TTL_DAYS"]) ?? 7) * DAY_MS,
    maxSessions: positiveInt(process.env["REEMOAT_MAX_SESSIONS"]),
    minSessions: positiveInt(process.env["REEMOAT_MIN_SESSIONS"]),
    // Each store's message names its own subject, so this prefix must not name one.
    onDegraded: (detail) => console.error(`store degraded: ${detail}`),
    // A routine prune is reported on stdout, never as a degradation.
    onPruned: (detail) => console.log(`store: ${detail}`),
  });
} catch (error) {
  console.error(
    `could not open ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n` +
      "  Set REEMOAT_DB to a writable path, or REEMOAT_DB=:memory: to run without durability.",
  );
  process.exit(2);
}

// Printed for comparison against cpctl admin fleet; before serving and dialling, since the dial announces it.
const machineKey = ensureMachineKey(stores.machineKeys);
console.log(`machine key: ${machineKey.kth}`);

const enrollmentWarning = enrollmentIgnored(process.env["REEMOAT_AUTH"], stores.identity.load());
if (enrollmentWarning !== null) console.error(`warning: ${enrollmentWarning}`);

interface AuthSetup {
  verifier: TokenVerifier;
  /** `null` under the shared secret, which has no machine and no control plane. */
  machineId: string | null;
  /** Both halves of a usable relay, or `null`. */
  relay: { relayUrl: string; tunnelKey: string } | null;
  /** The control plane the stored identity enrolled with, for the announcement only; not REEMOAT_CONTROL_PLANE, which only enrollment reads. */
  controlPlane: string | null;
}

const { verifier, machineId, relay: enrolledRelay, controlPlane: enrolledControlPlane } = await buildVerifier();

let workspacePolicy;
try {
  workspacePolicy = {
    worktreeRoot: resolveWorktreeRoot(process.env["REEMOAT_WORKTREE_ROOT"], stateHome),
    branchPrefix: (process.env["REEMOAT_BRANCH_PREFIX"] ?? DEFAULT_BRANCH_PREFIX).trim() || DEFAULT_BRANCH_PREFIX,
    defaultMode: worktreeMode(process.env["REEMOAT_WORKTREE"]),
  };
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

let uploadRoot: string;
try {
  uploadRoot = resolveUploadRoot(process.env["REEMOAT_UPLOAD_ROOT"], stateHome);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const pluginRoot = expandHome(process.env["REEMOAT_PLUGIN_ROOT"] ?? join(stateHome, "plugins"));

// No two remover trees may nest, or one remover can reach into another's tree.
const REMOVER_TREES: readonly { name: string; path: string }[] = [
  { name: "REEMOAT_UPLOAD_ROOT", path: uploadRoot },
  { name: "REEMOAT_WORKTREE_ROOT", path: workspacePolicy.worktreeRoot },
  { name: "REEMOAT_PLUGIN_ROOT", path: pluginRoot },
];
for (const [index, tree] of REMOVER_TREES.entries()) {
  for (const other of REMOVER_TREES.slice(index + 1)) {
    if (atOrUnder(tree.path, other.path) || atOrUnder(other.path, tree.path)) {
      console.error(`${tree.name} (${tree.path}) and ${other.name} (${other.path}) must not contain one another`);
      process.exit(2);
    }
  }
}

let uploads: Uploads;
try {
  uploads = await Uploads.open({
    root: uploadRoot,
    index: stores.uploads,
    onWarning: (detail: string) => console.error(`uploads: ${detail}`),
  });
} catch (error) {
  console.error(`cannot open the upload root: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

if (stores.prunedSessions.length > 0) {
  void uploads.forgetSessions(stores.prunedSessions);
}

// Built before the runtime, registry and restore: with contributions unknown, restore would drop every preset on a plugin's harness.
const pluginsEnabled = process.env["REEMOAT_PLUGINS"] !== "0";
// Switched off means every row disabled, not gone: an empty list would make session creation blame a correct request.
const contributions = new Contributions(
  stores.plugins.list().map((one) => (pluginsEnabled ? one : { ...one, enabled: false })),
);

const runtime = new LocalRuntime({
  // Read at launch rather than captured, so a replaced token applies to the next session.
  secrets: (agent) => stores.credentials.envFor(agent),
  // Kept apart from secrets: this becomes a provider header and must never reach an agent's environment.
  systemSecret: (system) =>
    systemSecretFor(
      system,
      stores.systemCredentials.get(system),
      (agent: AgentId) => stores.credentials.envFor(agent),
      contributions,
    ),
  machine: contributions,
  onWarning: (detail: string) => console.error(`runtime: ${detail}`),
});

const agentLogins = new AgentLoginRuns({
  runtime,
  onWarning: (detail: string) => console.error(`agent login: ${detail}`),
});

// The cwd is an empty directory this daemon owns: whatever the agent gets is where it may look.
const askRoot = expandHome(process.env["REEMOAT_ASK_ROOT"] ?? join(stateHome, "ask"));
mkdirSync(askRoot, { recursive: true, mode: 0o700 });
const agentAsks = new AgentAskRuns({ runtime, cwd: askRoot });

const registry = new SessionRegistry(
  stores.events,
  stores.sessions,
  workspacePolicy,
  runtime,
  uploads,
  (detail: string) => console.error(`session: ${detail}`),
);
// Listening before anything launches: the endpoint is handed to every agent after its initialize.
const PEER_MESSAGES_OFF: ReadonlySet<string> = new Set(["off", "0", "false", "no", "never"]);
const peerMessages = !PEER_MESSAGES_OFF.has((process.env["REEMOAT_PEER_MESSAGES"] ?? "").trim().toLowerCase());
const peers = new PeerHub({
  registry,
  enabled: peerMessages,
  machineId,
  network: createPeerNetwork(stores.peerLinks, stores.machineKeys),
  outbox: stores.peerOutbox,
  onWarning: (detail: string) => console.error(`peers: ${detail}`),
});
const peerEndpoint = peerMessages ? await PeerMcpEndpoint.listen(peers) : null;
peers.setEndpoint(peerEndpoint?.url ?? null);
registry.setPeerMcpServers((sessionId, capabilities) => peers.mcpServersFor(sessionId, capabilities));
peers.startOutbox();
// Before restore, or a preset's sessions resume on the bare harness; the harness goes back so ManagedSession.assembled can spot a changed preset.
registry.setMachineCatalogue(contributions);
registry.setCustomAgents((id) => {
  const one = stores.customAgents.get(id);
  return one === null ? null : { harness: one.harness, system: one.system, model: one.model };
});
// Only after openStores claimed the daemon lock: orphan reaping would otherwise SIGKILL a live daemon's agents.
const restored = registry.restore({ reapOrphans: process.env["REEMOAT_REAP_ORPHANS"] !== "0" });
const autoResume = process.env["REEMOAT_AUTO_RESUME"] !== "0";
registry.setAutoResume(autoResume);
const elicitation = process.env["REEMOAT_ELICITATION"] !== "0";
registry.setElicitation(elicitation);
const ultracode = process.env["REEMOAT_CLAUDE_ULTRACODE"] === "1";
registry.setUltracode(ultracode);

registry.setSessionLimits({
  live: boundedInt(process.env["REEMOAT_MAX_LIVE_SESSIONS"], MAX_LIVE_SESSIONS),
  burst: boundedInt(process.env["REEMOAT_SESSION_CREATE_BURST"], SESSION_CREATE_BURST),
  refillMs: boundedInt(process.env["REEMOAT_SESSION_CREATE_REFILL_MS"], SESSION_CREATE_REFILL_MS),
  // 0 is the only way to switch parking off: boundedInt treats a non-integer or a negative as unset.
  idleParkMs:
    boundedInt(process.env["REEMOAT_IDLE_PARK_MINUTES"], IDLE_PARK_MS / 60_000) * 60_000,
  turnSilenceMs:
    boundedInt(process.env["REEMOAT_TURN_SILENCE_MINUTES"], TURN_SILENCE_MS / 60_000) * 60_000,
});
// After setSessionLimits, because what the settings screen stores overrides the env values (Q2.225).
registry.setMachineSettingsStore(stores.machineSettings);

const idleParking = IdleParking.start({
  park: () => registry.parkIdleSessions(),
  enabled: () => registry.idleParkEnabled,
  onParked: (ids) => {
    console.log(
      `parked ${ids.length} idle session(s), agent(s) released: ${ids.join(", ")}`,
    );
  },
  reap: () => registry.abandonWedgedTurns(),
  reapEnabled: () => registry.turnSilenceEnabled,
  onAbandoned: (ids) => {
    console.log(
      `gave up on ${ids.length} turn(s) the agent never answered: ${ids.join(", ")}`,
    );
  },
});

// deploycheck reads this list off the source so deploy.sh honours the same spellings.
const AGENT_UPDATES_OFF: ReadonlySet<string> = new Set(["off", "0", "false", "no", "never"]);

// Shared by the daily refresh and a pressed install, because the invalidations are an order a second copy would drift from.
const afterAgentsChanged = (agent?: string): void => {
  // First: it clears the findOnPath miss, so every later is-it-there verdict must follow it.
  runtime.forgetAvailability();
  // The capability cache, which forgetAvailability cannot reach, holds the model list with the build that published it.
  agentAsks.forget(agent);
  resumeInterrupted(agent === undefined ? "after the agent update" : `after installing ${agent}`);
};

// Serialises this daemon's own runs of deploy/agents.sh; the script's lock catches an orphan from a previous daemon.
const agentScriptGate = new AgentScriptGate();

const agentUpdates = AgentUpdates.start({
  gate: agentScriptGate,
  busy: () => [
    ...new Set(
      registry
        .list()
        .filter((session) => !session.terminal && session.agentHandle !== null)
        .map((session) => session.agent),
    ),
  ],
  onWarning: (detail: string) => console.error(`agent update: ${detail}`),
  onUpdated: (report: string | null) => {
    console.log(`agent update: ran deploy/agents.sh${report === null ? "" : `\n${report.replace(/^/gm, "    ")}`}`);
    afterAgentsChanged();
  },
  mode: AGENT_UPDATES_OFF.has((process.env["REEMOAT_AGENT_UPDATES"] ?? "").trim().toLowerCase()) ? "off" : "daily",
  source: agentSourceFrom(process.env["REEMOAT_AGENT_SOURCE"], (detail: string) => console.error(`agent update: ${detail}`)),
  // The env file decides the channel, not the script's default (Q4.115).
  channel: agentChannelFrom(process.env["REEMOAT_AGENT_CHANNEL"], (detail: string) => console.error(`agent update: ${detail}`)),
});

// verify runs after afterAgentsChanged, or it reads findOnPath's cached miss and reports a successful install as failed.
const agentInstalls =
  AGENT_UPDATES_OFF.has((process.env["REEMOAT_AGENT_UPDATES"] ?? "").trim().toLowerCase())
    ? undefined
    : new AgentInstallRuns({
        gate: agentScriptGate,
        verify: async (agent: string) => (await runtime.agentCli(agent)) !== null,
        onFinished: (agent: string) => afterAgentsChanged(agent),
        onWarning: (detail: string) => console.error(`agent install: ${detail}`),
        source: agentSourceFrom(process.env["REEMOAT_AGENT_SOURCE"], () => {}),
        channel: agentChannelFrom(process.env["REEMOAT_AGENT_CHANNEL"], () => {}),
      });

// Opened after restore so the host sees every restored session; plugin starts are not awaited.
let pluginHost: PluginHost | null = null;
if (pluginsEnabled) {
  try {
    pluginHost = await PluginHost.open({
      root: pluginRoot,
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: {
        git: registry.sessionRuntime.git(),
        maxChangedFiles: positiveInt(process.env["REEMOAT_CHANGES_MAX_FILES"]),
        maxDiffBytes: positiveInt(process.env["REEMOAT_DIFF_MAX_BYTES"]),
        ask: agentAsks,
      },
      onWarning: (detail: string) => console.error(`plugins: ${detail}`),
      contributions,
      secrets: {
        // Swept off the stores rather than the manifest, so rows an earlier version declared or an unparseable manifest owns go too.
        forgetPrefix: (prefix) => {
          for (const row of stores.credentials.list()) {
            if (row.agent.startsWith(prefix)) stores.credentials.remove(row.agent, row.envName);
          }
          for (const row of stores.systemCredentials.list()) {
            if (row.system.startsWith(prefix)) stores.systemCredentials.remove(row.system);
          }
        },
      },
    });
  } catch (error) {
    // Not fatal: running without plugins beats leaving sessions unreachable.
    console.error(`plugins: cannot open ${pluginRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const { app, injectWebSocket } = createApp({
  registry,
  verifier,
  instanceId,
  startedAt,
  maxChangedFiles: positiveInt(process.env["REEMOAT_CHANGES_MAX_FILES"]),
  maxDiffBytes: positiveInt(process.env["REEMOAT_DIFF_MAX_BYTES"]),
  credentials: stores.credentials,
  systems: {
    credentials: stores.systemCredentials,
    customAgents: stores.customAgents,
    strip: stores.agentStrip,
  },
  machineSettings: stores.machineSettings,
  asks: agentAsks,
  logins: agentLogins,
  installs: agentInstalls,
  uploads,
  roots,
  plugins: pluginHost,
  peers: { hub: peers, links: stores.peerLinks },
});

if ((process.env["REEMOAT_RELAY"] ?? "").trim().length > 0) {
  console.error(
    "warning: REEMOAT_RELAY is set and no longer does anything.\n" +
      "  The relay is the only way in — this daemon binds loopback and the registry\n" +
      "  holds no address for it — so there is nothing to opt out of.",
  );
}
let tunnel: RelayTunnel | null = null;

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Reemoat daemon ${instanceId} listening on http://${host}:${info.port}`);
  console.log(`roots: ${roots.join(", ")}`);
  console.log(
    `worktrees: ${workspacePolicy.defaultMode === "never" ? "disabled" : workspacePolicy.worktreeRoot}`,
  );
  console.log(
    `agent login: ${
      runtime.loginSupported ? "available" : "unavailable (no `script` on PATH) — paste a token instead"
    }`,
  );
  console.log(`state: ${dbPath}`);
  console.log(threadpoolNote());
  console.log(`auth: ${authMode}${machineId === null ? "" : ` (machine ${machineId})`}`);
  console.log(`questions: ${elicitation ? "agents may ask" : "off (REEMOAT_ELICITATION=0)"}`);
  if (restored.restored > 0) {
    console.log(
      `restored ${restored.restored} session(s); ` +
        `${restored.interrupted} interrupted by the last restart` +
        (restored.reaped > 0 ? `, ${restored.reaped} orphaned agent(s) killed` : ""),
    );
  }
  // Inside the listening callback: the bound address is unknown until the bind completes, which REEMOAT_PORT=0 depends on.
  const local = localAddress(info, host, port);
  startRelayTunnel(local);
  announceLocally(local);
});

function announceLocally(local: { host: string; port: number }): void {
  if (machineId === null || authMode === "shared_secret") return;
  if (local.port === 0) {
    return;
  }
  try {
    writeAnnounce(
      {
        v: ANNOUNCE_VERSION,
        machineId,
        host: local.host,
        port: local.port,
        instanceId,
        authMode,
        controlPlane: enrolledControlPlane,
      },
      stateHome,
    );
    console.log(`local: announced at ${local.host}:${local.port} for apps on this computer`);
  } catch (error) {
    console.error(`local: could not announce this daemon (${describe(error)}); clients will use the relay`);
  }
}
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `${host}:${port} is already in use.\n` +
        "Another process — very likely another Reemoat daemon — holds it.\n" +
        "Nothing outside this machine addresses this listener: browsers arrive through the\n" +
        "relay, which routes by the token's `aud` and dials loopback on its own. So the port\n" +
        "only has to be free, and only has to be *known* to things running here —\n" +
        "`pnpm client` and deploy/deploy.sh's /health probe.\n" +
        "  • Pick another one:      REEMOAT_PORT=7888\n" +
        "  • Or let the kernel choose, and give up the two local callers above:\n" +
        "                           REEMOAT_PORT=0",
    );
    process.exit(2);
  }
  if (error.code === "EACCES") {
    console.error(
      `cannot bind ${host}:${port}: permission denied.\n` +
        "Ports below 1024 need privileges this daemon should not have. Use a higher port, or 0.",
    );
    process.exit(2);
  }
  throw error;
});

injectWebSocket(server as unknown as Server);

// Not awaited: deploy.sh gives /health 30 seconds, and the pass starts one agent per interrupted session.
resumeInterrupted("at boot");

function resumeInterrupted(when: string): void {
  void registry
    .autoResume({
      enabled: autoResume,
      onOutcome: (outcome) => {
        // Only the ends: a crash-looping agent would otherwise log every attempt.
        if (outcome.result === "resumed" || outcome.result === "failed") return;
        console.error(
          `auto-resume ${outcome.sessionId}: ${outcome.result}` +
            (outcome.detail === null ? "" : ` — ${outcome.detail}`),
        );
      },
    })
    .then((report) => {
      if (report.considered === 0) return;
      console.log(
        `auto-resume ${when}: ${report.resumed}/${report.considered} session(s) reattached` +
          (report.skipped > 0 ? `, ${report.skipped} skipped` : "") +
          (report.failed > 0 ? `, ${report.failed} failed` : "") +
          (report.deferred > 0
            ? `, ${report.deferred} waiting for an agent CLI — install it under Settings → Agents`
            : ""),
      );
    })
    .catch((error: unknown) => {
      console.error(`auto-resume ${when}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

function startRelayTunnel(local: { host: string; port: number }): void {
  if (enrolledRelay === null) {
    if (machineId !== null) {
      console.error(
        "this machine enrolled but has no relay to dial, so nothing can reach it.\n" +
          "  The daemon binds loopback and the registry holds no address for it, so the\n" +
          "  tunnel is the only way in. Either the control plane runs no relay, or this\n" +
          "  daemon enrolled before it did — re-enroll with a fresh code to pick one up.",
      );
    }
    return;
  }
  if (local.port === 0) {
    console.error(
      "relay: could not determine the port this daemon bound to, so there is nowhere to splice\n" +
        "  tunnelled streams to. Set an explicit REEMOAT_PORT. Continuing without a tunnel.",
    );
    return;
  }

  tunnel = RelayTunnel.start({
    relayUrl: enrolledRelay.relayUrl,
    tunnelKey: enrolledRelay.tunnelKey,
    local,
    agentClis: () => announcedAgentClis(runtime),
    // A value, not a function: a key rotation hands the tunnel its replacement.
    machineKey: machineKey.publicKey,
    // Never leaves this process: the relay carries ciphertext it cannot read.
    staticKey: localStaticKey(new Uint8Array(Buffer.from(machineKey.privateKey, "base64url"))),
    // Enrollment must finish before the listener exists, or it would pin the key booted on rather than the one announced.

    rotateMachineKey: machineKeyRotation(stores.machineKeys, machineKey),
    verifier,
    onEvent: (kind, detail) => {
      if (kind === "connected") console.log(`relay: tunnel up (${detail})`);
      else if (kind === "rejected") console.error(`relay: ${detail}`);
      else if (kind === "disconnected") console.error(`relay: tunnel down (${detail}); retrying`);
      else if (kind === "backpressure" || kind === "stream_error") console.error(`relay: ${detail}`);
    },
  });
  console.log(`relay: dialing ${enrolledRelay.relayUrl} (local ${local.host}:${local.port})`);
}

/** The bound address rather than the configured bind address; port 0 means could not tell, and the tunnel then refuses to dial. */
function localAddress(info: unknown, configuredHost: string, configuredPort: number): { host: string; port: number } {
  if (typeof info === "object" && info !== null && "port" in info) {
    const bound = info as { address?: string; port: number; family?: string };
    const address = bound.address ?? "";
    const wildcard = address === "0.0.0.0" || address === "::" || address === "";
    const host = wildcard ? (bound.family === "IPv6" ? "::1" : "127.0.0.1") : address;
    if (bound.port > 0) return { host, port: bound.port };
  }
  const wildcard = configuredHost === "0.0.0.0" || configuredHost === "::" || configuredHost === "";
  return { host: wildcard ? "127.0.0.1" : configuredHost, port: configuredPort };
}

/** A crashed daemon orphans every agent it owns, so a stray rejection is reported rather than fatal. */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});

/** The synchronous backstop: a daemon that owns live agents must not exit on a stray throw. */
process.on("uncaughtException", (error) => {
  console.error("uncaught exception (continuing):", error);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.error(`${signal} again — exiting immediately`);
    process.exit(130);
  }
  shuttingDown = true;

  const live = registry.list().filter((session) => !session.terminal).length;
  console.error(`\n${signal}: stopping ${live} session(s)…`);

  const hard = setTimeout(() => {
    console.error("shutdown exceeded its budget — exiting");
    process.exit(130);
  }, SHUTDOWN_HARD_LIMIT_MS);
  hard.unref();

  // First: a stale announcement costs the next local probe; keyed on instanceId so it never removes another daemon's file.
  try {
    removeAnnounce(instanceId, stateHome);
  } catch {
    // A crash leaves it behind anyway, so nothing may depend on this running.
  }
  // Before the sessions, so the relay stops handing this daemon new work.
  await tunnel?.stop();
  server.close();
  await agentLogins.shutdown();
  // A run in flight is not killed: a SIGKILL partway through an npm install leaves a tree the next run must repair.
  agentInstalls?.shutdown();
  await agentUpdates.shutdown();
  await idleParking.shutdown();
  // Before the plugin host: an ask is started by a plugin, and nothing else would collect its agent.
  await agentAsks.shutdown();
  await pluginHost?.shutdown();
  await uploads.shutdown();
  await registry.shutdown();
  // After the agents: a tool call in flight during their stop still gets an answer.
  peers.close();
  await peerEndpoint?.close();
  // After registry shutdown: stopping a session writes its exit record.
  stores.close();
  clearTimeout(hard);
  console.error("stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

type AuthMode = "shared_secret" | "signed" | "both";

/** both is a migration and break-glass mode: the shared secret still bypasses every grant and scope. */
function resolveAuthMode(value: string | undefined): AuthMode {
  const raw = (value ?? "shared_secret").trim().toLowerCase();
  if (raw === "" || raw === "shared_secret" || raw === "secret") return "shared_secret";
  if (raw === "signed") return "signed";
  if (raw === "both") return "both";
  console.error(`REEMOAT_AUTH must be shared_secret, signed or both, got "${value}"`);
  process.exit(2);
}

/** Enrolls only when a code is set and differs from the one already redeemed. */
async function buildVerifier(): Promise<AuthSetup> {
  const shared = token && token.length > 0 ? new SharedSecretVerifier(token) : null;

  if (authMode === "shared_secret") {
    if (shared === null) {
      // Unreachable while the top-of-file check exits; written out so it fails closed if that check moves.
      console.error("REEMOAT_TOKEN is required for REEMOAT_AUTH=shared_secret.");
      process.exit(2);
    }
    return { verifier: shared, machineId: null, relay: null, controlPlane: null };
  }

  const controlPlane = (process.env["REEMOAT_CONTROL_PLANE"] ?? "").trim();
  const code = (process.env["REEMOAT_ENROLL_CODE"] ?? "").trim();

  if (dbPath === ":memory:") {
    console.error(
      "warning: REEMOAT_DB=:memory: cannot persist this machine's identity.\n" +
        "  Every restart re-enrolls, and enrollment codes are single-use, so the next\n" +
        "  restart needs a fresh REEMOAT_ENROLL_CODE.",
    );
  }

  let identity: StoredIdentity | null;
  try {
    identity = stores.identity.load();
  } catch (error) {
    console.error(`could not read this machine's stored identity: ${describe(error)}`);
    process.exit(2);
  }

  const fingerprint = code.length > 0 ? codeFingerprint(code) : null;
  const needsEnrollment = fingerprint !== null && identity?.codeFp !== fingerprint;

  if (needsEnrollment) {
    if (controlPlane.length === 0) {
      console.error(
        "REEMOAT_ENROLL_CODE is set but REEMOAT_CONTROL_PLANE is not.\n" +
          "  export REEMOAT_CONTROL_PLANE=https://control-plane.example",
      );
      process.exit(2);
    }
    console.log(`enrolling with ${controlPlane}…`);
    try {
      // Announces the machine key generated before enrollment; announcing a later one would pin the wrong key.
      const result = await enroll({ controlPlane, code, machineKey: machineKey.publicKey });
      identity = {
        machineId: result.machineId,
        issuer: result.issuer,
        keys: result.keys,
        controlPlane,
        codeFp: fingerprint,
        enrolledAt: Date.now(),
        tunnelKey: result.tunnelKey,
        relayUrl: result.relayUrl,
      };
      stores.identity.save(identity);
      console.log(`enrolled as ${identity.machineId} (${identity.keys.length} key(s), issuer ${identity.issuer})`);
      if (identity.relayUrl !== null) {
        console.log(`relay: ${identity.relayUrl} (every client reaches this daemon through it)`);
      }
    } catch (error) {
      const rejected = error instanceof EnrollError && error.code === "code_rejected";
      const hint = rejected ? "\n  Enrollment codes are single-use and expire. Ask for a fresh one." : "";
      console.error(`enrollment failed: ${describe(error)}${hint}`);
      process.exit(
        rejected
          ? EXIT_CODE_REFUSED
          : error instanceof EnrollError && error.code === "local_network"
            ? EXIT_LOCAL_NETWORK_BLOCKED
            : error instanceof EnrollError && (error.code === "unreachable" || error.code === "timeout")
              ? EXIT_CONTROL_PLANE_UNREACHABLE
              : 2,
      );
    }
  }

  if (identity === null) {
    console.error(
      `REEMOAT_AUTH=${authMode} but this machine has never enrolled.\n` +
        "  Ask the control plane operator for an enrollment code, then start with:\n" +
        "  export REEMOAT_CONTROL_PLANE=https://control-plane.example\n" +
        "  export REEMOAT_ENROLL_CODE=ec_…",
    );
    process.exit(2);
  }

  // A relay needs both halves; with only one, behave as if there is none rather than dial anonymously.
  const relay =
    identity.relayUrl !== null && identity.tunnelKey !== null
      ? { relayUrl: identity.relayUrl, tunnelKey: identity.tunnelKey }
      : null;

  const signed = new SignedTokenVerifier({
    identity,
    onSuspectedClockSkew: (detail) => console.error(`clock skew: ${detail}`),
  });
  if (signed.keyCount === 0) {
    console.error(
      "the stored machine identity holds no usable Ed25519 key, so no token could ever verify.\n" +
        "  Re-enroll with a fresh code to repair it.",
    );
    process.exit(2);
  }

  if (authMode === "both") {
    if (shared === null) {
      console.error("REEMOAT_AUTH=both requires REEMOAT_TOKEN to be set as well.");
      process.exit(2);
    }
    return {
      verifier: new CompositeVerifier(signed, shared),
      machineId: identity.machineId,
      relay,
      controlPlane: announcedControlPlane(identity.controlPlane),
    };
  }
  return {
    verifier: signed,
    machineId: identity.machineId,
    relay,
    controlPlane: announcedControlPlane(identity.controlPlane),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** auto makes a worktree when the cwd is a git repository with a commit; never turns worktrees off. */
function worktreeMode(value: string | undefined): WorktreePolicy {
  const raw = (value ?? "auto").trim().toLowerCase();
  if (raw === "never" || raw === "0" || raw === "off" || raw === "false") return "never";
  if (raw === "require") return "require";
  return "auto";
}

/** Never relative to the cwd, so state does not depend on the launching terminal. */
function resolveDbPath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw.length === 0) return DEFAULT_DB;
  if (raw === ":memory:") return raw;
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    console.error(`REEMOAT_DB must be an absolute path or ":memory:", got "${raw}"`);
    process.exit(2);
  }
  return expanded;
}
