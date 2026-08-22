#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { serve } from "@hono/node-server";
import {
  CompositeVerifier,
  SharedSecretVerifier,
  SignedTokenVerifier,
  enrollmentIgnored,
  type TokenVerifier,
} from "../src/auth.js";
import { AgentLoginRuns } from "../src/agentauth.js";
import { LocalRuntime } from "../src/runtime/local.js";
import { resolveRoots } from "../src/browse.js";
import { codeFingerprint, enroll, EnrollError } from "../src/enroll.js";
import { boundedInt } from "../src/http.js";
import { atOrUnder, expandHome } from "../src/paths.js";
import {
  MAX_LIVE_SESSIONS,
  SESSION_CREATE_BURST,
  SESSION_CREATE_REFILL_MS,
  SessionRegistry,
  type WorktreePolicy,
} from "../src/registry.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { createApp } from "../src/server.js";
import { openStores, type StoreBundle, type StoredIdentity } from "../src/store/sqlite.js";
import { PluginHost } from "../src/plugins/host.js";
import { resolveUploadRoot, Uploads } from "../src/uploads.js";
import { DEFAULT_BRANCH_PREFIX, resolveWorktreeRoot } from "../src/worktree.js";

/*
 * 7887, not 7777.
 *
 * 7777 is occupied on the development machine by a Plane container stack that
 * restarts itself, so the no-configuration path used to dial another service
 * entirely — which fails as a puzzling protocol error rather than as a refused
 * connection. `.env.example` has always said 7887; this is the default catching up
 * with it.
 */
const DEFAULT_PORT = 7887;

/**
 * How many filesystem calls may be in flight at once.
 *
 * libuv's threadpool is **4** by default and every `node:fs/promises` call in
 * this process draws from it. That is a thin budget for a daemon whose routes are
 * almost entirely filesystem work, and a dangerous one next to a call that never
 * returns: a hard NFS mount whose server has paused blocks inside the kernel,
 * cannot be interrupted, and keeps its slot for the life of the process. Four
 * such calls and *every* later `await` on `fs` here queues for ever, while
 * `/health`, which touches no files, goes on reporting the daemon up.
 * `src/browse.ts` and `src/stall.ts` bound how often that cost is paid; this is
 * what makes the budget large enough to absorb it.
 *
 * **Set in two places, and the belt is here while the braces are in the shell.**
 * libuv reads the variable once, lazily, when the first piece of work reaches the
 * pool. In ESM every `import` above is evaluated before this statement runs, so
 * this only works while nothing in that graph touches the threadpool during
 * loading — measured 2026-08-03 against the real import list, 16 concurrent
 * `pbkdf2` jobs take ~150ms with this assignment and ~240ms with the pool forced
 * to 4, i.e. it is taking effect today. That is a property of the current imports
 * rather than a guarantee, and it fails silently: one future dependency that
 * reads a file asynchronously at load time latches the pool at 4 and nothing
 * says so.
 *
 * So `deploy/run-daemon.sh` and the `daemon` script in `package.json` also export
 * it before `node` starts, which is the only placement that cannot be outrun, and
 * {@link threadpoolNote} reports what the process actually ended up with. Only
 * when unset, because an operator who has tuned it has a reason.
 */
process.env["UV_THREADPOOL_SIZE"] ??= "64";

/** What the pool actually is, printed at startup because a silent 4 is the failure. */
function threadpoolNote(): string {
  const configured = (process.env["UV_THREADPOOL_SIZE"] ?? "").trim();
  const size = Number(configured);
  if (Number.isInteger(size) && size > 0) return `threadpool: ${size}`;
  return (
    "threadpool: 4 (default) — UV_THREADPOOL_SIZE is unset.\n" +
    "  Every fs call shares those 4 slots and a stalled network mount holds one for ever."
  );
}

/**
 * Loopback, and this is the line that makes "the relay is the only entrance"
 * true rather than merely intended.
 *
 * It was `0.0.0.0` so a Tailnet address worked without extra configuration, back
 * when a browser reached a daemon directly. It does not: every request arrives
 * down a tunnel this daemon dialled out, and the relay splices each CONNECT to a
 * fresh loopback connection here. Nothing outside ever addresses this listener.
 *
 * Clearing a machine's address in the registry was never the lever on its own —
 * the daemon went on listening on every interface regardless, and a client that
 * had already memoised a direct route went on using it. This is.
 *
 * The port stays known and stays 7887 by default, because `pnpm client`,
 * `pnpm harness` and `deploy/lib.sh`'s `/health` probe all reach it from *this*
 * machine, where loopback is the point rather than the obstacle. `REEMOAT_PORT=0`
 * is still supported for a daemon that is only ever served by the relay.
 */
const DEFAULT_HOST = "127.0.0.1";
const SHUTDOWN_HARD_LIMIT_MS = 25_000;
const DEFAULT_DB = join(homedir(), ".reemoat", "reemoat.db");
const DAY_MS = 86_400_000;

/**
 * How this daemon decides who is asking.
 *
 * `shared_secret` is the default and the whole single-machine story: one
 * secret, no control plane, exactly as it worked before any of this existed.
 */
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
  // Not fatal, but it must not be believed to be a way in. A leftover secret in
  // a shell profile is exactly how somebody ends up thinking the daemon is
  // reachable two ways when it is reachable one.
  console.error(
    "warning: REEMOAT_AUTH=signed, so REEMOAT_TOKEN is ignored — the shared secret is not accepted.",
  );
}

/*
 * `0` is allowed, and means "let the kernel pick a free one".
 *
 * This used to reject it (`port < 1`), which made a scenario the relay was
 * deliberately hardened for unreachable through the one variable that names it:
 * `RelayTunnel.start` is called from inside the listening callback precisely so
 * it learns the port actually bound rather than the configured value, and a
 * `localAddress` of port 0 is treated as "could not tell" and refuses to dial.
 * All of that defends against an ephemeral port that this check forbade.
 *
 * A port is the one host-global resource a daemon holds, and `0` is genuinely
 * usable now: the relay routes by the verified `aud` claim and splices each
 * CONNECT to a fresh loopback connection here, so nothing outside ever addresses
 * this listener and the port need not be known.
 *
 * The default stays 7887 anyway, because the things that *do* address it are on
 * this machine: `pnpm client` under the shared secret, and the deploy script's
 * `/health` probe.
 */
const port = Number.parseInt(process.env["REEMOAT_PORT"] ?? String(DEFAULT_PORT), 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`REEMOAT_PORT must be a valid port, or 0 to be assigned one, got "${process.env["REEMOAT_PORT"]}"`);
  process.exit(2);
}
const host = process.env["REEMOAT_HOST"] ?? DEFAULT_HOST;

/*
 * Where the directory picker starts.
 *
 * `REEMOAT_ROOTS` is back, and it is a *narrowing of the listing* rather than a
 * boundary — the agent runs as this user and can reach anything they can, so a
 * narrower root is about not scrolling past `/Library`, not about safety. Unset,
 * the picker starts at this user's home.
 */
const roots = resolveRoots(process.env["REEMOAT_ROOTS"]);

/*
 * Settings that used to mean something, warned about rather than swallowed.
 *
 * The rule this follows was written for `REEMOAT_ROOTS` when it was the one
 * being retired, and it applies unchanged in the other direction: silently
 * dropping a setting somebody wrote on purpose is how a boundary ends up
 * somewhere other than where they think it is.
 *
 * `REEMOAT_USER_ROOT` gets its own line because its value names a directory that
 * holds real sessions and worktrees, written by a daemon that no longer reads
 * there. "Ignored" is not enough to say about that one.
 */
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

// Strict at startup, degrading at runtime. Silently falling back to a memory
// store after the operator asked for durability is the kind of thing you find
// out about at the worst possible moment.
let stores: StoreBundle;
try {
  stores = openStores({
    path: dbPath,
    instanceId,
    // The same numbers as before. They now bound retention on disk rather than a
    // ring in memory, and they must stay under the outbound queue bound in
    // server.ts — see the note there. Tunable mostly so the eviction path — the
    // one case where "no gaps" degrades to "here is exactly what you lost" — can
    // be exercised without generating tens of thousands of events.
    maxEventsPerSession: positiveInt(process.env["REEMOAT_LOG_EVENTS"]),
    maxBytesPerSession: positiveInt(process.env["REEMOAT_LOG_BYTES"]),
    retainSessionsMs: (positiveInt(process.env["REEMOAT_SESSION_TTL_DAYS"]) ?? 7) * DAY_MS,
    maxSessions: positiveInt(process.env["REEMOAT_MAX_SESSIONS"]),
    // Nothing in src/ prints. This is the only way an operator hears that the
    // disk stopped accepting writes and the log has gone lossy.
    onDegraded: (detail) => console.error(`event store degraded — the log is now lossy: ${detail}`),
  });
} catch (error) {
  console.error(
    `could not open ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n` +
      "  Set REEMOAT_DB to a writable path, or REEMOAT_DB=:memory: to run without durability.",
  );
  process.exit(2);
}

/*
 * The reverse of the enrollment check further down, and it has to read the store
 * to make it.
 *
 * `machineId` below is null under `shared_secret` — that mode never establishes
 * an identity — so the daemon had no way to notice it was ignoring one. Asking
 * the store directly is the whole point: the row is there whatever mode this is.
 * `enrollmentIgnored` owns the rule and `authcheck` asserts it; here it is only
 * printed, with the other startup warnings.
 */
const enrollmentWarning = enrollmentIgnored(process.env["REEMOAT_AUTH"], stores.identity.load());
if (enrollmentWarning !== null) console.error(`warning: ${enrollmentWarning}`);

/*
 * Identity, and the verifier built from it.
 *
 * Runs after the store is open — the identity lives in the same database — and
 * before the server serves, because a daemon that cannot establish who it is
 * must not start answering requests about it.
 */
/**
 * Identity, and whatever came with it.
 *
 * Returned rather than assigned to module-level state from inside the function,
 * so "was this daemon enrolled, and did it get a relay" is answered by one value
 * a reader can follow instead of by two variables mutated out of sight.
 */
interface AuthSetup {
  verifier: TokenVerifier;
  /** `null` under the shared secret, which has no machine and no control plane. */
  machineId: string | null;
  /** Both halves of a usable relay, or `null`. */
  relay: { relayUrl: string; tunnelKey: string } | null;
}

const { verifier, machineId, relay: enrolledRelay } = await buildVerifier();

let workspacePolicy;
try {
  workspacePolicy = {
    worktreeRoot: resolveWorktreeRoot(process.env["REEMOAT_WORKTREE_ROOT"]),
    branchPrefix: (process.env["REEMOAT_BRANCH_PREFIX"] ?? DEFAULT_BRANCH_PREFIX).trim() || DEFAULT_BRANCH_PREFIX,
    defaultMode: worktreeMode(process.env["REEMOAT_WORKTREE"]),
  };
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

let uploadRoot: string;
try {
  uploadRoot = resolveUploadRoot(process.env["REEMOAT_UPLOAD_ROOT"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const pluginRoot = expandHome(process.env["REEMOAT_PLUGIN_ROOT"] ?? join(homedir(), ".reemoat", "plugins"));

/*
 * **Three** remover trees now, and no two of them may nest.
 *
 * `removeWorkspace` guards the codebase's original `rm` with
 * `containedIn(root, worktreeRoot)`, the upload sweep guards the second with the
 * mirror of that, and `PluginHost.discard` guards the third the same way. If any
 * root sits at or under another, one remover can reach into another's tree and
 * none of the guards means what it says any more — a worktree removal could take
 * somebody's staged files, an uninstall could take a checkout. Refused at startup,
 * where it is a loop, rather than discovered at the moment something is deleted.
 *
 * ⚠ The rule did not change when the third arrived; its *arity* did. Written as a
 * pairwise loop over a named list for exactly that reason: a fourth tree is one
 * entry here rather than three more `if`s somebody has to remember to write.
 */
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

/*
 * Staged files belonging to sessions the startup prune just deleted.
 *
 * The rows went with them inside `prune`'s own transaction; only the directories
 * are left, and only this side knows where they are. Fire-and-forget because it
 * is housekeeping — nothing serves these paths any more, so nothing waits on it.
 */
if (stores.prunedSessions.length > 0) {
  void uploads.forgetSessions(stores.prunedSessions);
}

/*
 * Where agents run: as children of this daemon, as this user.
 *
 * There used to be a paragraph here explaining that there was deliberately no
 * switch back to this, because "a flag that turns the sandbox off is a flag that
 * will be off somewhere". That was true of the product it described. This one is
 * a personal tool: the agent runs with your credentials on your files, exactly
 * as it would if you had started it in a terminal, and the honest place to say so
 * is `CLAUDE.md`'s "What is not confined" rather than a flag nobody sets.
 */
const runtime = new LocalRuntime({
  // The user's own pasted credential, read at launch rather than captured, so
  // replacing a token takes effect on the next session without a restart.
  secrets: (agent) => stores.credentials.envFor(agent),
  // Nothing in src/ prints. A login that cannot be driven is the one an operator
  // most needs to hear about, because the button for it is on a screen.
  onWarning: (detail: string) => console.error(`runtime: ${detail}`),
});

/**
 * Interactive agent logins.
 *
 * Constructed here rather than inside the registry because it is not part of a
 * session's lifecycle: it runs before there is a session, and often instead of
 * one failing.
 */
const agentLogins = new AgentLoginRuns({
  runtime,
  onWarning: (detail: string) => console.error(`agent login: ${detail}`),
});

const registry = new SessionRegistry(
  stores.events,
  stores.sessions,
  workspacePolicy,
  runtime,
  uploads,
  // The sixth argument, and it was written and then not passed: `SessionLog`'s
  // fan-out guard evicts a listener that threw, the listeners are live
  // WebSockets, and with nothing here that socket stops receiving events for the
  // rest of its life with nothing anywhere saying so. Same shape as `runtime`'s
  // and `agentLogins`' above, for the same reason — nothing in `src/` prints.
  (detail: string) => console.error(`session: ${detail}`),
);
// Before the server serves, and only ever after openStores claimed the daemon
// lock: the orphan reaping in here would otherwise SIGKILL a live daemon's agents.
const restored = registry.restore({ reapOrphans: process.env["REEMOAT_REAP_ORPHANS"] !== "0" });
// The other half of what this daemon does about processes it did not start in
// this life. Read here rather than in `src/`, which touches no environment.
const autoResume = process.env["REEMOAT_AUTO_RESUME"] !== "0";
registry.setAutoResume(autoResume);
/*
 * Whether an agent may ask a person a question.
 *
 * Read here for the same reason as the line above — nothing in `src/` touches the
 * environment — and it is a *thunk* on the other side, because `restore()` has
 * already run by this point and a boolean captured at construction would be stale
 * for every session it brought back.
 *
 * Turning it off withdraws a tool rather than a piece of UI: measured against
 * claude-agent-acp 0.63.0, declaring `elicitation.form` is what stops
 * `AskUserQuestion` being put in `disallowedTools`. Which is why the switch
 * exists at all — on a machine nobody is watching, a session that used to finish
 * now parks on a human until the turn is swept.
 */
const elicitation = process.env["REEMOAT_ELICITATION"] !== "0";
registry.setElicitation(elicitation);
/*
 * Whether a claude session nobody has decided about asks for ultracode.
 *
 * Read here for the same reason as the two above, and it is a thunk on the other
 * side for the stronger version of the same argument: `restore()` has already run,
 * and this is the setting whose whole point is that it applies to the sessions
 * this daemon just brought back.
 *
 * Opt-in rather than default-on. It is a real change to how the agent works —
 * highest effort and every turn planned as a workflow — so a machine that wants it
 * says so, and any session can still overrule it from the effort menu.
 */
const ultracode = process.env["REEMOAT_CLAUDE_ULTRACODE"] === "1";
registry.setUltracode(ultracode);

/*
 * How many sessions may run at once, and how fast new ones may be made.
 *
 * Read here rather than in `registry.ts` like everything else on this screen, and
 * overridable because the defaults are backstops rather than opinions: a machine
 * that really does drive fifty agents should say so, and one shared with somebody
 * whose scripts are new should be able to say the opposite.
 *
 * What they exist for is in `MAX_LIVE_SESSIONS`'s own docblock — the short
 * version is that `create()` had no bound at all and the only thing counting
 * sessions was a *deletion*, so a loop on a shared machine took the owner's
 * transcripts with it at the next restart.
 */
registry.setSessionLimits({
  live: boundedInt(process.env["REEMOAT_MAX_LIVE_SESSIONS"], MAX_LIVE_SESSIONS),
  burst: boundedInt(process.env["REEMOAT_SESSION_CREATE_BURST"], SESSION_CREATE_BURST),
  refillMs: boundedInt(process.env["REEMOAT_SESSION_CREATE_REFILL_MS"], SESSION_CREATE_REFILL_MS),
});

/*
 * Plugins, if this machine wants them.
 *
 * `REEMOAT_PLUGINS=0` is a real switch rather than a courtesy: a plugin is
 * somebody else's code running as this user, and an operator who does not want
 * that on a particular host should not have to uninstall anything to say so. With
 * it off the routes answer `503` — the shape `credentials`, `logins` and
 * `uploads` already use — instead of reporting an empty list, because "there are
 * none" and "this daemon does not do that" are different answers.
 *
 * Opened **after** the registry has restored, so `PluginHost.open` sees every
 * session this daemon already knows about and a hook does not have to be told
 * about them one at a time. Not awaited into the listener: a plugin that will not
 * start must not hold up a boot `deploy.sh` is polling `/health` for.
 */
let pluginHost: PluginHost | null = null;
if (process.env["REEMOAT_PLUGINS"] !== "0") {
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
      },
      onWarning: (detail: string) => console.error(`plugins: ${detail}`),
    });
  } catch (error) {
    // Not fatal, and deliberately so: a plugin root that cannot be made is a
    // reason to run without plugins, never a reason to leave somebody's sessions
    // unreachable on a machine nobody is sitting in front of.
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
  logins: agentLogins,
  uploads,
  roots,
  plugins: pluginHost,
});

/*
 * The relay tunnel, which is the only way in.
 *
 * `REEMOAT_RELAY=0` used to opt out of it and serve the direct path only. There
 * is no direct path: this daemon binds loopback and the registry records no
 * address, so opting out of the relay is opting out of being reachable at all —
 * not a configuration, a broken install. The variable is gone rather than
 * ignored, and a value left in an old environment file is warned about below.
 *
 * The cost, stated where it will be read: this daemon holds a permanent outbound
 * connection to its control plane, and an outage there now costs *all*
 * reachability where it used to cost nothing. What it still does not cost is
 * anything running: verification is entirely local, the tunnel is never *asked*
 * anything, and a session in flight neither notices nor stops.
 */
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
  // Printed because it is the only way to find out *before* tapping the wizard
  // that this daemon will decline it. The paste box always works either way.
  console.log(
    `agent login: ${
      runtime.loginSupported ? "available" : "unavailable (no `script` on PATH) — paste a token instead"
    }`,
  );
  console.log(`state: ${dbPath}`);
  console.log(threadpoolNote());
  console.log(`auth: ${authMode}${machineId === null ? "" : ` (machine ${machineId})`}`);
  // Printed because it changes what the *agent* can do rather than what a client
  // draws: off, claude is not given `AskUserQuestion` at all, and somebody
  // wondering why it never asks should be able to see that here.
  console.log(`questions: ${elicitation ? "agents may ask" : "off (REEMOAT_ELICITATION=0)"}`);
  if (restored.restored > 0) {
    console.log(
      `restored ${restored.restored} session(s); ` +
        `${restored.interrupted} interrupted by the last restart` +
        (restored.reaped > 0 ? `, ${restored.reaped} orphaned agent(s) killed` : ""),
    );
  }
  /*
   * Inside the listening callback, not after `serve` returns.
   *
   * `serve` hands back the server before the bind has completed, so
   * `server.address()` is `null` at every synchronous point after it —
   * measured, on every host form including a literal IP. Dialling from out
   * there meant `localAddress` always took its configured-value fallback,
   * which is right by luck for a fixed port and wrong for `REEMOAT_PORT=0`:
   * the tunnel would connect and then splice every stream to port 0.
   *
   * Nothing about the daemon coming up depends on the relay answering — this
   * runs once the server is already serving, and `RelayTunnel.start` returns
   * immediately and dials in the background.
   */
  startRelayTunnel(localAddress(info, host, port));
});
/*
 * A refused bind is a configuration mistake, so it reads like one.
 *
 * Without this the process died on a raw `EADDRINUSE` stack trace, which is the
 * odd one out: every other startup refusal above — no `REEMOAT_TOKEN`, an
 * unparseable `REEMOAT_PORT` — prints what is wrong and what to do about it and
 * exits 2. Less likely than it was — there is one daemon per host now rather
 * than one per OS user — but a port is still the only host-global resource a
 * daemon holds, and something else on the box may already have this one.
 *
 * The advice differs by routing policy, so the message gives both halves: a
 * machine reachable directly needs a stable port that matches its `baseUrl`, and
 * a relay-only machine does not need a chosen port at all.
 */
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
  // Anything else is not a known misconfiguration, and guessing at advice would
  // be worse than the stack trace.
  throw error;
});

injectWebSocket(server as unknown as Server);

/*
 * Put agents back on the sessions the last daemon ended, and do not wait for it.
 *
 * `void` and out here, after the listener and outside its callback, because the
 * pass starts one agent per interrupted session and `deploy.sh` waits on
 * `/health` for 30 seconds before calling the deploy failed. A boot that sat
 * behind even two ACP handshakes would report a healthy daemon as a failed
 * update; a boot that sat behind twenty would be a timeout every time.
 *
 * Nothing here awaits it and nothing depends on it: a session it misses is one
 * the prompt route resumes the moment somebody types, which is the same code by
 * a different door.
 */
void registry
  .autoResume({
    enabled: autoResume,
    onOutcome: (outcome) => {
      // Only the ends, not the attempts. A crash-looping agent would otherwise
      // fill the log with the same sentence three times per session per boot,
      // and the interesting line is the one that says it stopped trying.
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
      `auto-resume: ${report.resumed}/${report.considered} session(s) reattached` +
        (report.skipped > 0 ? `, ${report.skipped} skipped` : "") +
        (report.failed > 0 ? `, ${report.failed} failed` : ""),
    );
  })
  .catch((error: unknown) => {
    // The pass swallows per-session failures itself, so reaching here means the
    // loop broke rather than a resume did. Say so and carry on: the daemon is
    // serving, and every session it did not reach is still resumable by hand.
    console.error(`auto-resume: ${error instanceof Error ? error.message : String(error)}`);
  });

function startRelayTunnel(local: { host: string; port: number }): void {
  if (enrolledRelay === null) {
    /*
     * No relay to dial, and whether that is fine depends on which mode this is.
     *
     * Under the shared secret it is the ordinary, healthy state: there is no
     * control plane, nothing enrolled, and `pnpm client` reaches this daemon on
     * loopback. Warning there would print a scary paragraph on a correct start.
     *
     * Under `signed` it is not fine at all — this daemon enrolled, binds
     * loopback, and has no tunnel, so nothing can reach it and there is no other
     * door to try. That used to be a survivable state because the direct path
     * existed; it is now the whole failure, and it is invisible from here unless
     * it is said.
     */
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
    // Only reachable if the listening callback reported no usable port. Dialling
    // a relay that would splice every stream to port 0 is worse than not dialling.
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
    // Nothing in src/ prints; this is where the words come out.
    onEvent: (kind, detail) => {
      if (kind === "connected") console.log(`relay: tunnel up (${detail})`);
      else if (kind === "rejected") console.error(`relay: ${detail}`);
      else if (kind === "disconnected") console.error(`relay: tunnel down (${detail}); retrying`);
      else if (kind === "backpressure" || kind === "stream_error") console.error(`relay: ${detail}`);
    },
  });
  console.log(`relay: dialing ${enrolledRelay.relayUrl} (local ${local.host}:${local.port})`);
}

/**
 * Where to splice tunnelled streams to.
 *
 * The bound address rather than the configured one, because the configured host
 * is a *bind* address: `0.0.0.0` means "every interface", and connecting to it is
 * not portable. `::` gets the same treatment. The port comes from the same place,
 * which is what makes `REEMOAT_PORT=0` work — and it only works because this is
 * called from the listening callback, where the bind has actually happened.
 *
 * The configured-value fallback stays for the case where the callback reports
 * something with no usable address at all. `port: 0` out of here means "could
 * not tell", and `startRelayTunnel` refuses to dial on it rather than splicing
 * every stream to a port nobody can connect to.
 */
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

/**
 * A crashed daemon orphans every agent it owns, so a stray rejection is reported
 * rather than fatal. The paths that matter are already guarded individually.
 */
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
});

/**
 * The same argument for the synchronous half, and it is not symmetry for its own
 * sake: the asymmetry cost a permanent crash loop once.
 *
 * A relay URL with an unspecial scheme (`htps://…`, which `new URL` accepts)
 * threw out of `new WebSocket` in `RelayTunnel.dial` on a path outside its own
 * `try`. With a rejection handler here and no exception handler, that reached
 * the default one: the process printed its whole startup banner and died, under
 * a unit with `KeepAlive`/`RunAtLoad`, so every restart re-ran `restore()` and
 * auto-resume and spawned agents that were killed seconds later. The scheme is
 * checked at the source now — `src/relay/tunnel.ts` records why that check is a
 * comparison rather than an assignment — and this is the backstop for the next
 * one, since the failure mode is "a daemon that owns live agents exits" either
 * way.
 *
 * A backstop, not a licence. It is deliberately the same shape as the relay's own
 * (`packages/control-plane/src/relay/main.ts`), which has carried one all along.
 */
process.on("uncaughtException", (error) => {
  console.error("uncaught exception (continuing):", error);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal: the operator is out of patience, and so are we.
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

  // Before the sessions, so the relay stops handing this daemon new work while it
  // is winding down. A tunnel closing is routine — clients fail over or retry.
  await tunnel?.stop();
  server.close();
  // A login in flight is a pty process nobody will ever type into again once
  // this daemon is gone. Stopped before the sessions because it is cheap and
  // unconditional, and because it is not on the 20s session budget.
  await agentLogins.shutdown();
  // Before the sessions, because a plugin's hooks are driven by session events
  // and stopping the sessions first would spend the shutdown budget delivering
  // exit notices to children that are about to be killed anyway.
  await pluginHost?.shutdown();
  // Only stops the sweep timer. Staged files are deliberately left on disk —
  // they outlive a restart by design, which is the whole reason the index is on
  // disk rather than in memory.
  await uploads.shutdown();
  await registry.shutdown();
  // After shutdown, not before: stopping a session writes its exit record, and
  // that write has to land before the database goes away.
  stores.close();
  clearTimeout(hard);
  console.error("stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

type AuthMode = "shared_secret" | "signed" | "both";

/**
 * `both` is a migration and break-glass mode, not a destination.
 *
 * Under it the shared secret still opens everything, bypassing every grant and
 * every scope the control plane issued. It exists because enrolling a daemon
 * you reach over the network is exactly the moment you can lock yourself out
 * of it, and having no way back in is worse than having a documented one.
 */
function resolveAuthMode(value: string | undefined): AuthMode {
  const raw = (value ?? "shared_secret").trim().toLowerCase();
  if (raw === "" || raw === "shared_secret" || raw === "secret") return "shared_secret";
  if (raw === "signed") return "signed";
  if (raw === "both") return "both";
  console.error(`REEMOAT_AUTH must be shared_secret, signed or both, got "${value}"`);
  process.exit(2);
}

/**
 * Establishes this machine's identity, enrolling first if it has to.
 *
 * The enrollment call is made when there is a code and it is not the code
 * already redeemed. That single comparison covers every restart case without a
 * flag anyone can set wrongly: same code, no network call; new code,
 * re-enrollment; no code with an identity already on disk, no network call at
 * all — which is what lets a daemon start with its control plane switched off.
 */
async function buildVerifier(): Promise<AuthSetup> {
  const shared = token && token.length > 0 ? new SharedSecretVerifier(token) : null;

  if (authMode === "shared_secret") {
    if (shared === null) {
      // Unreachable: the check at the top of this file already exits. Written
      // out rather than asserted so that if that check ever moves, this fails
      // closed instead of constructing a daemon with no credential at all.
      console.error("REEMOAT_TOKEN is required for REEMOAT_AUTH=shared_secret.");
      process.exit(2);
    }
    // No control plane in this mode, so no relay either: there is nobody to have
    // issued a tunnel credential and nowhere to present one.
    return { verifier: shared, machineId: null, relay: null };
  }

  const controlPlane = (process.env["REEMOAT_CONTROL_PLANE"] ?? "").trim();
  const code = (process.env["REEMOAT_ENROLL_CODE"] ?? "").trim();

  if (dbPath === ":memory:") {
    // Worth saying before it happens rather than after. The identity lives in
    // the database, so an in-memory one enrolls on every boot — and enrollment
    // codes are single-use, so the *second* boot fails with a code rejection
    // that looks like a control-plane problem and is not one.
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
    // Refusing to start beats silently re-enrolling or, worse, coming up with
    // no identity and rejecting tokens that were fine a minute ago.
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
      const result = await enroll({ controlPlane, code });
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
      const hint =
        error instanceof EnrollError && error.code === "code_rejected"
          ? "\n  Enrollment codes are single-use and expire. Ask for a fresh one."
          : "";
      console.error(`enrollment failed: ${describe(error)}${hint}`);
      process.exit(2);
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

  /*
   * A relay is only usable with both halves: somewhere to dial and something to
   * prove identity with. One without the other is a control plane that changed
   * shape between this daemon's enrollment and now, and the honest response is to
   * behave as though there is no relay rather than to dial one anonymously.
   */
  const relay =
    identity.relayUrl !== null && identity.tunnelKey !== null
      ? { relayUrl: identity.relayUrl, tunnelKey: identity.tunnelKey }
      : null;

  const signed = new SignedTokenVerifier({
    identity,
    // Nothing in src/ prints. This callback is the only way an operator hears
    // that tokens are being refused because this machine's clock has drifted —
    // the failure that otherwise presents as "auth mysteriously broke".
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
    return { verifier: new CompositeVerifier(signed, shared), machineId: identity.machineId, relay };
  }
  return { verifier: signed, machineId: identity.machineId, relay };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Whether a new session gets its own worktree.
 *
 * `auto` — the default — makes one whenever the cwd is a git repository with at
 * least one commit, and runs in the directory itself otherwise. `never` turns the
 * feature off daemon-wide.
 */
function worktreeMode(value: string | undefined): WorktreePolicy {
  const raw = (value ?? "auto").trim().toLowerCase();
  if (raw === "never" || raw === "0" || raw === "off" || raw === "false") return "never";
  if (raw === "require") return "require";
  return "auto";
}

/**
 * Where durable state lives.
 *
 * Deliberately not relative to the cwd: the daemon's state would then depend on
 * which terminal you launched it from, which is the same class of surprise the
 * agent env scrubbing in `acp/agents.ts` already defends against.
 */
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
