import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isBuiltinAgentId } from "../acp/agents.js";
import {
  isBuiltinSystemId,
  type AgentStripEntry,
  type CustomAgent,
  type SystemId,
} from "../acp/systems.js";
import { isContributedId } from "../plugins/manifest.js";
import type { UploadIndex, UploadRow } from "../uploads.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_EVENT_BYTES,
  estimateBytes,
  truncateEvent,
  type AgentHandle,
  type EventStore,
  type EventStoreStats,
  type PersistedSession,
  type SessionEvent,
  type SessionExit,
  type SessionStatus,
  type SessionStore,
  type SessionWorkspace,
  type StoredEvent,
} from "../events.js";
import { describeError } from "../http.js";
import { parseManifest } from "../plugins/manifest.js";
import {
  checkPluginWrite,
  type InstalledPlugin,
  type PluginDataStore,
  type PluginEntry,
  type PluginEntryPage,
  type PluginRecordStore,
} from "../plugins/store.js";

/**
 * Durable state, in one SQLite file.
 *
 * The interfaces this implements are synchronous, and that is not an accident of
 * Node's bindings being synchronous — it is what lets a client attach inside one
 * uninterruptible block, which is what makes gap-free resume true by construction.
 * Nothing in this file may become async. If it ever has to, put a write-behind
 * buffer in front of it rather than changing the shape of `append`.
 */

/**
 * v2 added `sessions.owner_subject` and the `identity` table.
 * v3 added `identity.tunnel_key` and `identity.relay_url`.
 * v4 added `sessions.container_id`, `agent_pgid` and `container_started_at`.
 *
 * Bumping this makes an older daemon refuse a file this one has written, which
 * is the intended direction: old code reading a new column mis-parses rather
 * than fails. It does not gate the migration itself — see `migrate`.
 *
 * v4 is worth the bump even though an old daemon would degrade quietly rather
 * than loudly: it would read `agent_pid` as NULL for every containerised session
 * and conclude no agent was ever recorded, so it would silently stop reaping the
 * orphans it exists to reap.
 *
 * v5 added `sessions.title` and `sessions.pinned`. The degradation here is milder
 * than v4's and the bump is still right: an old daemon's upsert simply omits both
 * columns, and a DO UPDATE clause that does not name a column leaves it alone, so
 * titles and pins would *survive* a downgrade rather than be erased. Refuse-newer
 * is the documented direction regardless — losing the file is a cheaper failure
 * than a fleet half-writing it.
 *
 * v6 dropped `forge_accounts` and rekeyed `agent_credentials` from
 * `(owner_subject, agent, env_name)` to `(agent, env_name)`, when the daemon
 * stopped being multi-tenant. Here the refuse-newer direction is **load-bearing
 * rather than advisory**, which is a first for this list: a v5 daemon opening a
 * v6 file would not mis-parse a column, it would throw inside
 * `SqliteAgentCredentialStore`'s constructor at `db.prepare`, as a SQLite parse
 * error naming a column that no longer exists — at startup, with nothing to say
 * what had happened. `refuseNewerSchema` gets there first and says it, and it runs
 * *before* `migrate()` rather than after, which is what makes that sentence true:
 * the check used to sit downstream of the rewrite it was supposed to prevent.
 *
 * `sessions.owner_subject` is **not** dropped, and that asymmetry is deliberate.
 * Nothing reads or writes it any more; it is left in place because `sessions` is
 * the largest table in the file and SQLite cannot drop a column without a
 * copy-drop-rename of the whole thing — risking every transcript on disk to
 * reclaim one nullable column per row. The two credential tables are small and
 * hold secrets, which is what makes rewriting them worth doing.
 */
export const SCHEMA_VERSION = 6;

/** Handed to SQLite as `busy_timeout`. See the note on transactions in `insert`. */
const BUSY_TIMEOUT_MS = 250;

/**
 * Eviction runs down to a mark *below* the bound rather than exactly to it.
 *
 * That is the whole of "amortized": one DELETE every ~256 appends instead of one
 * per append at steady state. Deleting to a low-water mark rather than letting
 * the log run past a high-water mark also keeps `count <= maxEvents` true at
 * every observable instant, which is what CLAUDE.md's Bounds table claims.
 */
const EVICT_SLACK_EVENTS = 256;
const EVICT_SLACK_BYTES = 512 * 1024;
const EVICT_CHUNK = 512;
/**
 * Hard cap on delete rounds per append.
 *
 * A single `append` must never turn into an unbounded synchronous delete on the
 * agent's event path. Anything still over the bound is caught on the next append.
 */
const EVICT_MAX_ROUNDS = 8;

const DEFAULT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 200;


export interface OpenStoresOptions {
  /** `:memory:` opts out of durability entirely — the old behaviour, on demand. */
  path: string;
  instanceId: string;
  maxEventsPerSession?: number | undefined;
  maxBytesPerSession?: number | undefined;
  maxEventBytes?: number | undefined;
  retainSessionsMs?: number | undefined;
  maxSessions?: number | undefined;
  /**
   * Fired once, on the transition into degraded.
   *
   * Nothing in `src/` writes to stdout or stderr, so this callback is the only
   * way an operator hears that the disk stopped accepting writes.
   */
  onDegraded?: ((detail: string) => void) | undefined;
}

export interface StoreBundle {
  db: DatabaseSync;
  events: SqliteEventStore;
  sessions: SqliteSessionStore;
  identity: SqliteIdentityStore;
  credentials: SqliteAgentCredentialStore;
  /** Keys for the systems a harness can be routed at. */
  systemCredentials: SqliteSystemCredentialStore;
  /** The harness+system+model presets somebody named on this machine. */
  customAgents: SqliteCustomAgentStore;
  /** Which agents the New session strip offers here, and in what order. */
  agentStrip: SqliteAgentStripStore;
  uploads: SqliteUploadStore;
  /** What is installed. See `src/plugins/store.ts` for why these are two subjects. */
  plugins: SqlitePluginRecordStore;
  /** What plugins have put here, keyed on the plugin's id and never on its version. */
  pluginData: SqlitePluginDataStore;
  /**
   * Sessions the startup prune deleted.
   *
   * Surfaced because their staged upload *directories* still exist and only the
   * caller can remove them — `prune()` runs before the upload root is known. See
   * `SqliteSessionStore.prune`.
   */
  prunedSessions: string[];
  close(): void;
}

/**
 * Opens the database and both stores.
 *
 * One factory rather than two constructors, because the startup steps have an
 * order that is only correct in one arrangement and it should not be possible to
 * get it wrong from `daemon.ts`. In particular the daemon lock has to be claimed
 * *before* pruning or restore, since restore's orphan reaping would otherwise
 * SIGKILL a live daemon's agents.
 *
 * Throws on anything that goes wrong. Startup is strict and runtime degrades:
 * silently falling back to memory after the operator asked for durability is the
 * kind of thing you find out about at the worst possible moment.
 */
export function openStores(options: OpenStoresOptions): StoreBundle {
  const inMemory = options.path === ":memory:";
  if (!inMemory) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });

  if (!inMemory) {
    // The file holds full agent transcripts and every file the agent changed.
    // That is at least as sensitive as REEMOAT_TOKEN, which already lives in a
    // gitignored file with no world access.
    //
    // The directory is chmodded too, and not as belt-and-braces: SQLite writes
    // `-wal` and `-shm` beside this file on its own schedule, they hold the same
    // transcript bytes until a checkpoint folds them back, and they are created
    // with whatever the umask says. Chasing those files is a losing race — they
    // are recreated — so the containing directory is the only durable answer.
    // `mkdirSync(mode)` above does not cover it either: that mode applies only to
    // directories it actually created, so an upgrade into an existing 0755
    // ~/.reemoat would otherwise leave the WAL world-readable.
    try {
      chmodSync(dirname(options.path), 0o700);
    } catch {
      // Same reasoning as below: not a reason to refuse to start.
    }
    try {
      chmodSync(options.path, 0o600);
    } catch {
      // A filesystem without POSIX modes (a mounted share) is not a reason to
      // refuse to start; the directory above was created 0700 either way.
    }
  }

  applyPragmas(db, inMemory);
  db.exec(loadSchema());
  // **The lock is claimed before the file is changed, and the order is the
  // point.** `migrate()` adds columns and `stampSchemaVersion` writes
  // `user_version`, both of which are permanent; running them first meant a
  // second daemon that was about to be *refused* had already upgraded the
  // database out from under the one still running. That daemon keeps working
  // until it restarts, at which point `refuseNewerSchema` refuses its own file
  // and there is no down migration. `CLAUDE.md`'s own `pkill` gotcha makes
  // exactly this sequence the likely upgrade path.
  //
  // Safe to run here because `claimDaemonLock` touches only the `daemon` table,
  // which `schema.sql` creates with `IF NOT EXISTS` above and which no schema
  // version has ever changed.
  claimDaemonLock(db, options.instanceId, options.path);
  // **Refused before it is migrated, and it was the other way round.** These two
  // lines used to be `migrate(db); checkSchemaVersion(db);`, and the docblock on
  // SCHEMA_VERSION said of exactly this case that "`checkSchemaVersion` gets
  // there first and says it". It did not: a file written by a newer daemon was
  // handed to `migrate()` — which rekeys `agent_credentials` by create-copy-drop-
  // rename and drops `forge_accounts` outright — before the guard whose entire
  // job is to stop old code touching a new file ever ran. The guards inside
  // `migrate` are on column presence, so today the damage is nil; the reason to
  // fix it anyway is that refuse-newer is protecting against a future this build
  // cannot see, and a v7 that reintroduced either shape would have it silently
  // collapsed by v6 code. Reading a pragma is free and cannot be the thing that
  // goes wrong.
  refuseNewerSchema(db);
  migrate(db);
  // Stamped only now, so the version on disk still means "every migration in
  // this build has run against this file".
  stampSchemaVersion(db);

  const sessions = new SqliteSessionStore(db, options.onDegraded);
  const prunedSessions = sessions.prune({
    retainMs: options.retainSessionsMs ?? DEFAULT_RETAIN_MS,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
  });

  const events = new SqliteEventStore(db, {
    maxEventsPerSession: options.maxEventsPerSession,
    maxBytesPerSession: options.maxBytesPerSession,
    maxEventBytes: options.maxEventBytes,
    onDegraded: options.onDegraded,
  });
  events.seedFloors(sessions.list());

  const identity = new SqliteIdentityStore(db);
  const credentials = new SqliteAgentCredentialStore(db);
  const systemCredentials = new SqliteSystemCredentialStore(db, options.onDegraded);
  const customAgents = new SqliteCustomAgentStore(db, options.onDegraded);
  const agentStrip = new SqliteAgentStripStore(db);
  const uploads = new SqliteUploadStore(db);
  const plugins = new SqlitePluginRecordStore(db, options.onDegraded);
  const pluginData = new SqlitePluginDataStore(db);

  return {
    db,
    events,
    sessions,
    identity,
    credentials,
    systemCredentials,
    customAgents,
    agentStrip,
    uploads,
    plugins,
    pluginData,
    prunedSessions,
    close() {
      try {
        // Fold the WAL back into the main file so the next open has nothing to
        // recover. Best effort: on the hard-exit path this never runs at all,
        // and an un-checkpointed WAL is recovered on the next open anyway.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Nothing actionable — we are on the way out.
      }
      try {
        db.exec("DELETE FROM daemon WHERE id = 1");
      } catch {
        // Same. A stale row is handled by the liveness check on the next open.
      }
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

function loadSchema(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

function applyPragmas(db: DatabaseSync, inMemory: boolean): void {
  // Returns a row, so it cannot go through exec().
  const mode = db.prepare("PRAGMA journal_mode = WAL").get();
  const journal = typeof mode?.["journal_mode"] === "string" ? mode["journal_mode"] : "";
  if (!inMemory && journal.toLowerCase() !== "wal") {
    throw new Error(
      `could not enable WAL journalling (got "${journal}"). ` +
        "A networked or read-only filesystem is the usual cause.",
    );
  }

  /*
   * `synchronous = NORMAL` means COMMIT does not fsync; the WAL is flushed on
   * checkpoint instead. That is the right point on the curve here, not a
   * compromise:
   *
   *   - A *process* death — SIGKILL, OOM, segfault, a restart — loses nothing.
   *     The dirty pages are in the OS page cache and the next open reads them
   *     back. That is the entire threat model: the daemon dying is exactly what
   *     this whole change exists to recover from.
   *   - A *machine* death can lose commits since the last checkpoint, but cannot
   *     corrupt the file — unlike `synchronous = OFF`. And the agents died with
   *     the machine, so durably recording the last forty events of a session
   *     whose subprocess no longer exists describes a world that is gone anyway.
   *   - `synchronous = FULL` would put an fsync — 1 to 10 ms — on the agent's
   *     synchronous emit path, which the first invariant in CLAUDE.md forbids
   *     outright: anything that blocks there blocks the agent.
   */
  db.exec("PRAGMA synchronous = NORMAL");
  // There are none. Saying so explicitly stops a future reader wondering whether
  // the missing FK on `events` is an oversight.
  db.exec("PRAGMA foreign_keys = OFF");
}

/**
 * The one thing `schema.sql` cannot express.
 *
 * That file is re-applied on every open and every statement in it is `CREATE
 * ... IF NOT EXISTS`, which is idempotent for whole tables and useless for a
 * column added to a table that already exists. A new table needs nothing here;
 * `sessions.owner_subject` does.
 *
 * Decided from `PRAGMA table_info` rather than from `user_version`, for two
 * reasons. It is idempotent by construction — it asks the database what it
 * actually has instead of trusting a number written beside it — and it survives
 * the case where the stamp is wrong, which is reachable today: `stampSchemaVersion`
 * writes the stamp on a fresh file before anything else touches it, so a crash
 * between the two would leave a v2 stamp over a v1 table. Asking the table
 * cannot be wrong about the table.
 *
 * Runs between `refuseNewerSchema` and `stampSchemaVersion`, so the version is
 * stamped only once the file
 * genuinely matches it.
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  const hasSession = (name: string): boolean => columns.some((column) => column["name"] === name);
  // No DEFAULT: NULL is the honest value for every session that predates the
  // column, and it is the same value the shared-secret path writes today.
  if (!hasSession("owner_subject")) db.exec("ALTER TABLE sessions ADD COLUMN owner_subject TEXT");

  // Where the agent ran, when it was not a child of this daemon.
  //
  // Three columns rather than a wider meaning for `agent_pid`, because a process
  // group inside a container is a different number space from a host pid and the
  // two must not be indistinguishable once written down. `container_started_at`
  // is the fence: measured 2026-07-30, a `docker restart` reset the container's
  // PID namespace (a fresh pid was 309 before and 15 after) while the host's
  // uptime — the fence the local runtime uses — was unchanged.
  //
  // NULL on every row the local runtime writes, which is also every row that
  // predates these columns, so nothing has to tell those two apart.
  if (!hasSession("container_id")) db.exec("ALTER TABLE sessions ADD COLUMN container_id TEXT");
  if (!hasSession("agent_pgid")) db.exec("ALTER TABLE sessions ADD COLUMN agent_pgid INTEGER");
  if (!hasSession("container_started_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN container_started_at INTEGER");
  }

  /*
   * Why the daemon permanently stopped trying to reattach an agent.
   *
   * No DEFAULT and nullable, like `owner_subject` above and for the same reason:
   * NULL is the honest value for every row that predates the column, and it is
   * also the value that means "still worth trying", which is what every one of
   * those rows deserves.
   *
   * `SCHEMA_VERSION` deliberately does not move for this. A nullable column an
   * older daemon never selects is invisible to it — `fromRow` reads by name and
   * would find nothing — so a rollback keeps working, and bumping the version
   * would make `refuseNewerSchema` refuse one to buy that nothing.
   */
  if (!hasSession("resume_gave_up")) db.exec("ALTER TABLE sessions ADD COLUMN resume_gave_up TEXT");

  // What the session is called, and whether it is kept at the top of the list.
  //
  // `pinned` carries a DEFAULT where `owner_subject` above deliberately does not,
  // and the difference is not a style choice twice over. SQLite refuses
  // `ADD COLUMN ... NOT NULL` outright without one — so a NOT NULL column added to
  // an existing table *must* have a default — and 0 happens to be the honest value
  // as well, because nothing written before this column existed was ever pinned.
  // For an owner, NULL is the honest value and there is no honest default, which
  // is why that one is nullable instead.
  if (!hasSession("title")) db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
  if (!hasSession("pinned")) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }

  // Whether somebody chose ultracode for this session. Nullable, and NULL is the
  // honest value for every row written before the column existed: nobody chose,
  // so those sessions follow the machine's setting exactly as a fresh one does.
  // `SCHEMA_VERSION` does not move, for `resume_gave_up`'s reason above — a
  // nullable column an older daemon never selects is invisible to it.
  if (!hasSession("ultracode")) db.exec("ALTER TABLE sessions ADD COLUMN ultracode INTEGER");

  // Which assembled agent this session was started as, or NULL for one started
  // on a bare harness — which is every session written before this column.
  //
  // ⚠ **`sessions.agent` still holds the harness, and that is what keeps this
  // change small.** A custom agent names a harness plus a system plus a model;
  // only the first of those decides which binary `resolveAgent` resolves, which
  // credentials `signOutSessions` clears, and what a restart relaunches. Storing
  // the harness where the harness has always been means none of those paths
  // learn about this column at all.
  //
  // It is a *reference*, not a copy of the row: the system and the model are
  // read back through `custom_agents` at resume, so editing a preset changes
  // what its sessions come back as. Nullable and never selected by an older
  // daemon, so `SCHEMA_VERSION` does not move — `resume_gave_up`'s reason.
  if (!hasSession("custom_agent")) db.exec("ALTER TABLE sessions ADD COLUMN custom_agent TEXT");


  // The relay fields on `identity`. NULL means "this daemon enrolled with a
  // control plane that offered no relay", which is both the honest value for
  // every identity that predates these columns and the value a control plane
  // without a relay writes today — so nothing has to distinguish them.
  const identityColumns = db.prepare("PRAGMA table_info(identity)").all();
  const has = (name: string): boolean => identityColumns.some((column) => column["name"] === name);
  if (!has("tunnel_key")) db.exec("ALTER TABLE identity ADD COLUMN tunnel_key TEXT");
  if (!has("relay_url")) db.exec("ALTER TABLE identity ADD COLUMN relay_url TEXT");

  migrateCredentialsToV6(db);
}

/**
 * v6: one person, so a credential is keyed by what it is for and nothing else.
 *
 * Two tables and two different answers, decided by what is in them.
 *
 * **`agent_credentials` is rewritten, not dropped.** A pasted `CLAUDE_CODE_OAUTH_TOKEN`
 * is still exactly as useful as it was, so losing it would be gratuitous. SQLite
 * cannot `DROP COLUMN` a member of the primary key, so this is the documented
 * create-copy-drop-rename, guarded on the column's presence so it is idempotent
 * and an already-v6 file costs one `PRAGMA`.
 *
 * The copy collapses duplicates, which is destructive and one-way — but only for
 * a file written by a multi-tenant daemon that really did hold two people's
 * tokens for one agent. On the machine this now runs on there is at most one
 * owner, so in practice every row copies unchanged. Newest wins, with
 * `owner_subject` as a deterministic tiebreak so the result does not depend on
 * row order.
 *
 * **`forge_accounts` is dropped, and that is because of what is in it.** The
 * feature is gone, and the table holds plaintext push tokens that do not expire
 * and that nothing in this system could ever revoke — `DELETE /forges/:host` was
 * the only thing that could, and it went with the routes. Leaving the table would
 * leave those secrets on disk with no code path able to end one. So this is the
 * last moment anybody can be told, and it says so out loud.
 */
function migrateCredentialsToV6(db: DatabaseSync): void {
  const credColumns = db.prepare("PRAGMA table_info(agent_credentials)").all();
  if (credColumns.some((column) => column["name"] === "owner_subject")) {
    db.exec("BEGIN");
    try {
      db.exec(
        "CREATE TABLE agent_credentials_v6 (" +
          "agent TEXT NOT NULL, env_name TEXT NOT NULL, secret TEXT NOT NULL, " +
          "updated_at INTEGER NOT NULL, PRIMARY KEY (agent, env_name))",
      );
      db.exec(
        "INSERT INTO agent_credentials_v6 (agent, env_name, secret, updated_at) " +
          "SELECT agent, env_name, secret, updated_at FROM (" +
          "  SELECT agent, env_name, secret, updated_at, ROW_NUMBER() OVER (" +
          "    PARTITION BY agent, env_name ORDER BY updated_at DESC, owner_subject ASC" +
          "  ) AS n FROM agent_credentials" +
          ") WHERE n = 1",
      );
      // **Counted before the DROP, because afterwards there is nothing to count.**
      // On a single-user file every row copies across and this is zero. On one
      // written by the multi-tenant daemon two people could each hold a
      // `CLAUDE_CODE_OAUTH_TOKEN` for `claude`, and the collapse keeps exactly one
      // — which `envFor` then injects into *every* agent this daemon spawns,
      // because it is no longer keyed by owner. That is somebody else's identity
      // and somebody else's billing, arriving silently on an upgrade. The
      // neighbouring `forge_accounts` drop announces itself for a smaller reason;
      // this one was doing more and saying nothing.
      const before = Number(db.prepare("SELECT COUNT(*) AS n FROM agent_credentials").get()?.["n"] ?? 0);
      const kept = Number(db.prepare("SELECT COUNT(*) AS n FROM agent_credentials_v6").get()?.["n"] ?? 0);
      db.exec("DROP TABLE agent_credentials");
      db.exec("ALTER TABLE agent_credentials_v6 RENAME TO agent_credentials");
      db.exec("COMMIT");
      if (before > kept) {
        console.error(
          `Reemoat: ${before - kept} pasted agent credential(s) were dropped — this database was ` +
            "written when the daemon served several people, and a credential is now one per " +
            "(agent, variable) rather than one per person. The most recently updated survived; " +
            "re-paste under Settings → Machines → Configure agent if it is not the one you want.",
        );
      }
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The BEGIN itself failed, so there is no transaction to roll back.
      }
      throw error;
    }
  }

  // Counted before it is dropped, because after the DROP there is nothing left to
  // count and nobody to tell. This is the one place in `src/` that prints, and it
  // earns the exception: the alternative is destroying a credential somebody
  // minted, silently, on an upgrade they did not know did that.
  const forgeRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='forge_accounts'").all();
  if (forgeRows.length > 0) {
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM forge_accounts").get()?.["n"] ?? 0);
    // The hosts, not just how many. Counting told somebody that secrets were
    // destroyed and left them no way to act on it; the whole value of this line
    // is that they can go and revoke the tokens, and for that they need to know
    // where. Read before the DROP, because afterwards there is nothing to read.
    const hosts =
      count > 0
        ? db
            .prepare("SELECT DISTINCT host FROM forge_accounts ORDER BY host")
            .all()
            .map((row) => String(row["host"]))
        : [];
    db.exec("DROP TABLE forge_accounts");
    if (count > 0) {
      console.error(
        `Reemoat: dropped ${count} connected forge account(s) — that feature is gone and the ` +
          `tokens with it. They do not expire, so revoke them on the forge if you have not: ` +
          `${hosts.join(", ")}`,
      );
    }
  }
}

/**
 * The half that must run before anything is written. See `openStores`.
 *
 * The remedy is named, because there is no down migration and the operator
 * hitting this is usually mid-rollback: `deploy/deploy.sh --ref <sha>` is
 * advertised as the way back, and it cannot cross a schema bump. Saying "move
 * the file aside" is not a nice answer, but it is the true one and it beats a
 * daemon that refuses to start with no next step.
 */
function refuseNewerSchema(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const found = Number(row?.["user_version"] ?? 0);
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `this file was written by a newer Reemoat (schema v${found}, this is v${SCHEMA_VERSION}). ` +
        "Old code reading new columns mis-parses rather than fails, so it refuses instead.\n" +
        "There is no down migration. Deploy a build at or above that schema, or move " +
        `${"the database aside"} and start fresh — the transcripts in it are not readable by this build.`,
    );
  }
}

function stampSchemaVersion(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  if (Number(row?.["user_version"] ?? 0) !== SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * Refuses to start when another daemon already owns this file.
 *
 * Two daemons on one path would hold stale in-memory `lastSeq` counters, collide
 * on the primary key, and drive every append in *both* processes into the
 * degradation path — and each would try to reap the other's agents as orphans.
 *
 * Rejected the harder `PRAGMA locking_mode = EXCLUSIVE`: it would make the file
 * unreadable by the `sqlite3` CLI while the daemon runs, and for a tool whose
 * whole value is "you can find out what your agents are doing", losing external
 * inspectability of the transcript store is a bad trade for a misconfiguration
 * that a clear error message already covers.
 */
function claimDaemonLock(db: DatabaseSync, instanceId: string, path: string): void {
  const row = db.prepare("SELECT instance_id, pid, started_at FROM daemon WHERE id = 1").get();
  if (row) {
    const pid = Number(row["pid"]);
    const startedAt = Number(row["started_at"]);
    if (pid !== process.pid && startedAt >= bootTime() && isAlive(pid)) {
      throw new Error(
        `another Reemoat daemon (pid ${pid}, instance ${String(row["instance_id"])}) owns ${path}.\n` +
          "  Stop it, or point this one somewhere else with REEMOAT_DB.",
      );
    }
  }
  db.prepare(
    "INSERT INTO daemon (id, instance_id, pid, started_at) VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, " +
      "pid = excluded.pid, started_at = excluded.started_at",
  ).run(instanceId, process.pid, Date.now());
}

/* ------------------------------------------------------------------------- *
 * Events
 * ------------------------------------------------------------------------- */

interface Counters {
  /** Lowest seq still on disk; 0 when nothing is. */
  firstSeq: number;
  /** Highest seq ever assigned. Survives eviction — it is the resume cursor. */
  lastSeq: number;
  count: number;
  dropped: number;
  bytes: number;
}

export interface SqliteEventStoreOptions {
  maxEventsPerSession?: number | undefined;
  maxBytesPerSession?: number | undefined;
  maxEventBytes?: number | undefined;
  onDegraded?: ((detail: string) => void) | undefined;
}

/**
 * The event log, on disk.
 *
 * Counters are cached in memory and derived once at construction, never
 * persisted per append. `stats()` is therefore a map lookup — which matters
 * because `ManagedSession.snapshot()` calls it on every state change, so three
 * index scans here would sit behind every permission settle.
 */
export class SqliteEventStore implements EventStore {
  private readonly counters = new Map<string, Counters>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxEventBytes: number;
  private readonly onDegraded: ((detail: string) => void) | undefined;

  private readonly insertStmt: StatementSync;
  private readonly readStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly minSeqStmt: StatementSync;
  private readonly dropStmt: StatementSync;

  private degraded = false;
  private lastError = "";

  constructor(db: DatabaseSync, options: SqliteEventStoreOptions = {}) {
    this.maxEvents = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.onDegraded = options.onDegraded;

    this.insertStmt = db.prepare(
      "INSERT INTO events (session_id, seq, ts, bytes, payload) VALUES (?, ?, ?, ?, ?)",
    );
    this.readStmt = db.prepare(
      "SELECT seq, ts, bytes, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    );
    // The `seq < ?` guard is "never delete the newest row", in SQL. It is what
    // keeps `lastSeq = MAX(seq)` derivable at load, and it mirrors
    // MemoryEventStore.evict stopping at `count <= 1`.
    this.deleteStmt = db.prepare(
      "DELETE FROM events WHERE rowid IN (" +
        "SELECT rowid FROM events WHERE session_id = ? AND seq < ? ORDER BY seq LIMIT ?" +
        ") RETURNING bytes",
    );
    this.minSeqStmt = db.prepare("SELECT seq FROM events WHERE session_id = ? ORDER BY seq LIMIT 1");
    this.dropStmt = db.prepare("DELETE FROM events WHERE session_id = ?");

    this.loadCounters(db);
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Rebuilds every counter in one grouped index scan.
   *
   * All five are derivable, and deriving beats persisting because a persisted
   * counter can drift from the rows if a crash lands between the INSERT and the
   * counter write. The preconditions:
   *
   *   - `dropped = firstSeq - 1` holds only because seqs are dense from 1 and
   *     eviction removes a strict prefix. A failed insert can leave a hole, which
   *     is most of why `append` writes a placeholder rather than skipping a seq.
   *   - `lastSeq = MAX(seq)` holds only because eviction never takes the newest
   *     row. `seedFloors` raises it afterwards for sessions whose events are gone
   *     entirely, which is the one case the table cannot answer.
   */
  private loadCounters(db: DatabaseSync): void {
    const rows = db
      .prepare(
        "SELECT session_id, MIN(seq) AS first_seq, MAX(seq) AS last_seq, " +
          "COUNT(*) AS count, SUM(bytes) AS bytes FROM events GROUP BY session_id",
      )
      .all();
    for (const row of rows) {
      const firstSeq = Number(row["first_seq"] ?? 0);
      this.counters.set(String(row["session_id"]), {
        firstSeq,
        lastSeq: Number(row["last_seq"] ?? 0),
        count: Number(row["count"] ?? 0),
        dropped: firstSeq > 0 ? firstSeq - 1 : 0,
        bytes: Number(row["bytes"] ?? 0),
      });
    }
  }

  /**
   * Raises `lastSeq`/`dropped` to the floor recorded on each session row.
   *
   * A floor, never a ceiling: a crash between an append and the `touchSafe()`
   * that would have recorded it leaves the row one behind the table, and taking
   * the max picks the table — self-healing in the only direction that is safe.
   *
   * Without this, a session whose events were pruned restarts at seq 1, and a
   * client resuming with `since=500` is clamped to 0 by `attach` and replayed
   * from the beginning — receiving *different events under numbers it has already
   * seen*, with nothing on the wire to say so.
   */
  seedFloors(rows: readonly PersistedSession[]): void {
    for (const row of rows) {
      const counters = this.countersFor(row.id);
      if (row.lastSeq > counters.lastSeq) counters.lastSeq = row.lastSeq;
      if (row.dropped > counters.dropped) counters.dropped = row.dropped;
    }
  }

  append(sessionId: string, event: SessionEvent): StoredEvent {
    const counters = this.countersFor(sessionId);
    // Burned here and never reused, whatever happens below. Two clients must
    // never see two different events under the same number.
    const seq = counters.lastSeq + 1;
    counters.lastSeq = seq;
    const ts = Date.now();

    // Truncate, measure and serialize together, because serialization is the one
    // failure mode SQLite adds that the memory store does not have: a cyclic
    // `rawInput` survives truncateEvent — jsonSize() swallows the cycle and
    // reports 4 KiB, under the 128 KiB ceiling, so nothing is shrunk — and then
    // throws in JSON.stringify.
    let payload: SessionEvent;
    let bytes: number;
    let json: string;
    try {
      payload = truncateEvent(event, this.maxEventBytes);
      bytes = estimateBytes(payload);
      const encoded = JSON.stringify(payload);
      if (typeof encoded !== "string") throw new Error("event serialized to undefined");
      json = encoded;
    } catch (error) {
      payload = {
        type: "error",
        message: `event could not be recorded: ${describeError(error)}`,
        data: null,
      };
      bytes = estimateBytes(payload);
      // Fixed shape with `data: null` — this one cannot throw.
      json = JSON.stringify(payload);
    }

    const stored: StoredEvent = { seq, ts, event: payload };
    if (this.insert(sessionId, seq, ts, bytes, json)) {
      this.credit(counters, seq, bytes);
      this.evict(sessionId, counters);
      return stored;
    }

    /*
     * The row did not land. Two things follow, and both are counter-intuitive.
     *
     * A placeholder goes in at the *same* seq rather than the seq being skipped.
     * A hole cannot cause the attach loop to spin — `read` is `seq > ?` — but it
     * is invisible on the wire: `lagged` is derived from firstSeq/lastSeq, so a
     * mid-log hole is never reported to anyone. A silent gap is the single
     * failure this whole subsystem exists to prevent.
     *
     * And the placeholder is what we *return*, not the real event. If a live
     * client is handed the real text at seq 412 while a reconnecting client is
     * handed a placeholder at seq 412, the two disagree about what seq 412 is and
     * neither can detect it. Both losing it is strictly better than diverging,
     * because the loss is visible and the divergence is not.
     *
     * There is deliberately no separate "the store is degraded" event: this store
     * cannot append to itself. SessionLog.append fans out only what its own call
     * to store.append returned, so a recursive append here would be written to
     * disk and delivered to nobody. The placeholder is the notice.
     */
    const note: SessionEvent = {
      type: "error",
      message: `seq ${seq} (${payload.type}) could not be persisted: ${this.lastError}`,
      data: null,
    };
    const noteBytes = estimateBytes(note);
    if (this.insert(sessionId, seq, ts, noteBytes, JSON.stringify(note))) {
      this.credit(counters, seq, noteBytes);
    }
    // If even that failed, the disk is refusing writes outright. The seq stays
    // burned and the log has a hole; the counters keep describing what is on
    // disk rather than what we wished were there.
    return { seq, ts, event: note };
  }

  read(sessionId: string, since: number, limit: number, maxBytes: number): StoredEvent[] {
    const out: StoredEvent[] = [];
    if (limit <= 0) return out;
    let bytes = 0;
    try {
      /*
       * `WHERE seq > ?` is what makes StreamConnection.attach terminate: it
       * cannot return a row at or below the cursor whatever the state of the
       * table, so read → emit → read always advances. The memory store gets the
       * same property from index arithmetic, which is the much harder argument.
       *
       * iterate() rather than all(): a page is 200 rows and one event may be
       * 128 KiB, so all() would materialize up to 25 MiB to return the handful
       * that fit a 512 KiB budget — inside a WebSocket upgrade handler. Breaking
       * out resets the statement; the next call is unaffected.
       */
      for (const row of this.readStmt.iterate(sessionId, since, limit)) {
        const rowBytes = Number(row["bytes"] ?? 0);
        // Always yield at least one, or a single oversized record wedges a reader
        // that can never make progress past it.
        if (out.length > 0 && bytes + rowBytes > maxBytes) break;
        out.push(decodeRow(row));
        bytes += rowBytes;
      }
    } catch (error) {
      this.markDegraded(describeError(error));
    }
    return out;
  }

  stats(sessionId: string): EventStoreStats {
    const counters = this.counters.get(sessionId);
    if (!counters) return { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
    return {
      firstSeq: counters.firstSeq,
      lastSeq: counters.lastSeq,
      count: counters.count,
      dropped: counters.dropped,
      approxBytes: counters.bytes,
    };
  }

  drop(sessionId: string): void {
    try {
      this.dropStmt.run(sessionId);
    } catch (error) {
      this.markDegraded(describeError(error));
    }
    // Dropped regardless: leftover rows are swept as orphans at the next startup,
    // and keeping a counter for a session we have forgotten is worse.
    this.counters.delete(sessionId);
  }

  private countersFor(sessionId: string): Counters {
    let counters = this.counters.get(sessionId);
    if (!counters) {
      counters = { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, bytes: 0 };
      this.counters.set(sessionId, counters);
    }
    return counters;
  }

  private credit(counters: Counters, seq: number, bytes: number): void {
    counters.count += 1;
    counters.bytes += bytes;
    if (counters.firstSeq === 0) counters.firstSeq = seq;
  }

  private insert(sessionId: string, seq: number, ts: number, bytes: number, json: string): boolean {
    try {
      // No explicit transaction. A bare statement is already its own implicit
      // transaction in SQLite, so BEGIN/COMMIT here would add two statement
      // executions and exactly zero atomicity — on the agent's emit path.
      this.insertStmt.run(sessionId, seq, ts, bytes, json);
      return true;
    } catch (error) {
      // No retry. `busy_timeout` already handles the only retryable case
      // internally, and SQLITE_FULL / IOERR / CORRUPT fail identically on a
      // second attempt — so a retry buys nothing and costs a second synchronous
      // statement per event, forever, once the disk fills.
      this.lastError = describeError(error);
      this.markDegraded(this.lastError);
      return false;
    }
  }

  private evict(sessionId: string, counters: Counters): void {
    if (counters.count <= this.maxEvents && counters.bytes <= this.maxBytes) return;

    // Clamped to a quarter of the window, because REEMOAT_LOG_EVENTS exists
    // precisely so this path can be exercised with a tiny log — and a fixed slack
    // of 256 against maxEvents=10 would delete the entire thing.
    const slack = Math.min(EVICT_SLACK_EVENTS, Math.max(Math.floor(this.maxEvents / 4), 1));
    const keepEvents = Math.max(this.maxEvents - slack, 1);
    const byteSlack = Math.min(EVICT_SLACK_BYTES, Math.max(this.maxBytes >> 4, 1));
    const keepBytes = Math.max(this.maxBytes - byteSlack, 1);

    for (let round = 0; round < EVICT_MAX_ROUNDS; round += 1) {
      if (counters.count <= keepEvents && counters.bytes <= keepBytes) break;
      if (counters.count <= 1) break;
      const chunk = Math.min(EVICT_CHUNK, counters.count - 1);
      let rows: Record<string, unknown>[];
      try {
        rows = this.deleteStmt.all(sessionId, counters.lastSeq, chunk);
      } catch (error) {
        // Eviction runs inside append, which must not throw.
        this.markDegraded(describeError(error));
        return;
      }
      if (rows.length === 0) break;
      for (const row of rows) counters.bytes -= Number(row["bytes"] ?? 0);
      counters.count -= rows.length;
      counters.dropped += rows.length;
    }

    // Exact, and only on the eviction path — never per append. Arithmetic on the
    // deleted seqs would be wrong the moment a failed insert left a hole.
    counters.firstSeq = this.minSeq(sessionId);
  }

  private minSeq(sessionId: string): number {
    try {
      const row = this.minSeqStmt.get(sessionId);
      return row ? Number(row["seq"] ?? 0) : 0;
    } catch (error) {
      this.markDegraded(describeError(error));
      return 0;
    }
  }

  private markDegraded(detail: string): void {
    if (this.degraded) return;
    this.degraded = true;
    try {
      this.onDegraded?.(detail);
    } catch {
      // A caller-supplied callback. Its failure is not ours to propagate, and we
      // are already on the path where something is badly wrong.
    }
  }
}

function decodeRow(row: Record<string, unknown>): StoredEvent {
  const seq = Number(row["seq"] ?? 0);
  const ts = Number(row["ts"] ?? 0);
  let event: SessionEvent;
  try {
    event = JSON.parse(String(row["payload"])) as SessionEvent;
  } catch (error) {
    // A corrupt row stays *in* the sequence rather than punching a hole in it,
    // which keeps `read` total and keeps the client's seq arithmetic honest.
    event = { type: "error", message: `seq ${seq} could not be decoded: ${describeError(error)}`, data: null };
  }
  return { seq, ts, event };
}

/* ------------------------------------------------------------------------- *
 * Sessions
 * ------------------------------------------------------------------------- */

export interface PruneOptions {
  retainMs: number;
  maxSessions: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly putStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly removeSessionStmt: StatementSync;
  private readonly removeEventsStmt: StatementSync;
  /** Last row written per session, so an unchanged `touchSafe` costs no WAL write. */
  private readonly lastWritten = new Map<string, string>();

  constructor(
    private readonly db: DatabaseSync,
    /**
     * Where a row this build cannot read gets reported.
     *
     * ⚠ **`fromRow` drops rows and said nothing, which is not this file's own
     * convention.** `SqlitePluginRecordStore` reports the identical class of fact
     * through this same sink, under a docblock saying "nobody is at the keyboard,
     * and the alternative is silence". A dropped *session* costs more than a
     * listing: `registry.restore()` walks `list()`, so the row is never announced,
     * never marked interrupted, and — the half that is not recoverable — its
     * recorded agent handle never reaches `runtime.reap`, which is the only reap
     * in `src/`. An agent that outlived the daemon's death then keeps running.
     */
    private readonly onDegraded: ((detail: string) => void) | undefined = undefined,
  ) {
    // `agent`, `created_at` and the workspace's identity are absent from the DO
    // UPDATE clause on purpose: they are immutable identity, and an upsert that
    // can rewrite them is one that can corrupt a row it was only meant to touch.
    // `last_seq`/`dropped` use scalar MAX so a stale writer can never walk a
    // cursor backwards.
    //
    // `title` and `pinned` *are* in the clause, and are the only columns here that
    // are meant to change after creation.
    //
    // `owner_subject` is no longer written at all. The column is still in the
    // table — see the note on SCHEMA_VERSION for why it is not worth rewriting
    // `sessions` to remove — and new rows leave it NULL.
    this.putStmt = db.prepare(
      `INSERT INTO sessions (
         id, agent, created_at, updated_at, agent_session_id, agent_pid, status, exit_json,
         container_id, agent_pgid, container_started_at,
         turn_counter, last_event_at, perm_seq, perm_salt, resume_gave_up, last_seq, dropped, title, pinned,
         ultracode, custom_agent,
         workspace_json, workspace_mode, workspace_root, workspace_branch, workspace_base
       ) VALUES (
         :id, :agent, :created_at, :updated_at, :agent_session_id, :agent_pid, :status, :exit_json,
         :container_id, :agent_pgid, :container_started_at,
         :turn_counter, :last_event_at, :perm_seq, :perm_salt, :resume_gave_up, :last_seq, :dropped, :title, :pinned,
         :ultracode, :custom_agent,
         :workspace_json, :workspace_mode, :workspace_root, :workspace_branch, :workspace_base
       )
       ON CONFLICT(id) DO UPDATE SET
         updated_at       = excluded.updated_at,
         title            = excluded.title,
         pinned           = excluded.pinned,
         ultracode        = excluded.ultracode,
         agent_session_id = excluded.agent_session_id,
         agent_pid        = excluded.agent_pid,
         container_id     = excluded.container_id,
         agent_pgid       = excluded.agent_pgid,
         container_started_at = excluded.container_started_at,
         status           = excluded.status,
         exit_json        = excluded.exit_json,
         turn_counter     = excluded.turn_counter,
         last_event_at    = excluded.last_event_at,
         perm_seq         = excluded.perm_seq,
         perm_salt        = excluded.perm_salt,
         resume_gave_up   = excluded.resume_gave_up,
         workspace_json   = excluded.workspace_json,
         workspace_mode   = excluded.workspace_mode,
         workspace_root   = excluded.workspace_root,
         workspace_branch = excluded.workspace_branch,
         workspace_base   = excluded.workspace_base,
         last_seq         = MAX(sessions.last_seq, excluded.last_seq),
         dropped          = MAX(sessions.dropped,  excluded.dropped)`,
    );
    this.listStmt = db.prepare("SELECT * FROM sessions ORDER BY created_at ASC");
    this.removeSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
    this.removeEventsStmt = db.prepare("DELETE FROM events WHERE session_id = ?");
  }

  put(row: PersistedSession): void {
    try {
      const params = toParams(row);
      // `doStop` calls touchSafe twice with identical content, and so does the
      // permission sweep. One string compare against one WAL write is a good
      // trade. Keyed without updated_at, which is stamped below.
      const key = JSON.stringify(params);
      if (this.lastWritten.get(row.id) === key) return;
      this.putStmt.run({ ...params, updated_at: Date.now() });
      this.lastWritten.set(row.id, key);
    } catch {
      // Swallowed: this runs from touchSafe(), on the agent's state-change path,
      // where a bookkeeping fault must not unwind a turn. The running session is
      // unaffected; restart fidelity loses one state change and the next
      // touchSafe recovers it.
    }
  }

  list(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const row of this.listStmt.all()) {
      const parsed = fromRow(row);
      // A row we cannot parse is a row we cannot honour. Skipping it loses one
      // session; letting it throw would lose every session after it.
      if (parsed) {
        out.push(parsed);
        continue;
      }
      /*
       * Said out loud, because the two consequences are not recoverable from a
       * listing that simply has one fewer row in it: this session is not restored,
       * and the agent process its row records is never reaped. Named rather than
       * counted — an operator reading this needs the id to go and look.
       */
      this.onDegraded?.(
        `session ${String(row["id"])} is in the database naming agent ` +
          `${JSON.stringify(String(row["agent"]))}, which this build does not have: ` +
          "it will not be restored and its agent process will not be reaped",
      );
    }
    return out;
  }

  remove(id: string): void {
    try {
      this.removeEventsStmt.run(id);
      this.removeSessionStmt.run(id);
      this.lastWritten.delete(id);
    } catch {
      // Leftovers are swept as orphans at the next startup.
    }
  }

  /**
   * Drops sessions past either bound, then sweeps events belonging to no session.
   *
   * Without this `registry.list()` grows without limit and `GET /sessions` ends
   * up serializing every session the machine has ever run.
   *
   * **Returns the ids it removed**, which is not bookkeeping for its own sake:
   * a pruned session's staged uploads are *files*, and the SQL below can only
   * reach their rows. `prune()` runs inside `openStores`, before the upload store
   * exists, so the directories have to be swept by somebody who is handed this
   * list rather than by moving the call — moving it would break the ordering that
   * docblock spends four paragraphs establishing. Empty on a rollback, which is
   * the honest answer: nothing was deleted, so nothing should be swept.
   */
  prune(options: PruneOptions): string[] {
    const cutoff = Date.now() - options.retainMs;
    // One transaction, not for atomicity — each statement is already atomic — but
    // so the WAL takes one commit instead of several.
    this.db.exec("BEGIN");
    try {
      /*
       * **A pin survives the age sweep**, and it did not.
       *
       * `server.ts`'s `listRank` already treats a pin as durable, with the reason
       * written out: "a `?limit=` cut that dropped it would make the pin a lie".
       * This statement made it a lie by a slower route — the API cut kept a pinned
       * session and the startup prune deleted it, with its whole transcript, at
       * seven days. Two halves of one system disagreeing about what a pin means,
       * and the disagreeing half was the destructive one.
       *
       * The bound is not lost, it moves to the count cap below: pins rank first
       * there, so a tenant can hold at most `maxSessions` of them and the table
       * stays as bounded as it was. Unbounded retention would be the other way to
       * read "keep this", and it is the one that lets one person's bookmarks
       * become everyone's disk.
       */
      const stale = this.db
        .prepare("SELECT id FROM sessions WHERE created_at < ? AND pinned = 0")
        .all(cutoff)
        .map((row) => String(row["id"]));
      // A plain cap across the table again. It was partitioned by owner while one
      // daemon served several people, because a global bound is a *shared* one and
      // somebody creating sessions in a loop would silently delete everybody
      // else's transcripts.
      //
      // ⚠ **That sentence used to end "with one person there is nobody to take it
      // from", and it was the bug report.** A grant is `(user_id, machine_id)` and
      // `POST /v1/tokens` mints for any holder, so the moment a machine is shared
      // there is somebody to take it from — and the loop it describes was
      // reachable, because `registry.create()` had no bound of any kind. Restoring
      // the partition is not the repair and cannot be: `owner_subject` is no
      // longer written (see the note by `putStmt`), so partitioning by it yields
      // one group, i.e. exactly this statement. What was missing was a bound on
      // *creation*, and it now lives at the only place that can hold one —
      // `MAX_LIVE_SESSIONS` and `SESSION_CREATE_BURST` in `registry.ts`, refusing
      // with 429 before a worktree exists. This cap stays what it always was: the
      // bound on the table, not a defence against whoever filled it.
      //
      // `pinned DESC` first, so a pin outranks recency here exactly as it does in
      // `listRank` — and so that this cap is what bounds pinned rows now that the
      // age sweep above no longer touches them.
      const excess = this.db
        .prepare(
          "SELECT id FROM (" +
            "SELECT id, ROW_NUMBER() OVER (" +
            "  ORDER BY pinned DESC, created_at DESC" +
            ") AS n FROM sessions" +
            ") WHERE n > ?",
        )
        .all(options.maxSessions)
        .map((row) => String(row["id"]));

      // **Said out loud, because this cap changed meaning and the change is
      // destructive.** It used to be `PARTITION BY COALESCE(owner_subject, ?)`,
      // i.e. `maxSessions` *per person*; it is now `maxSessions` across the file.
      // `prune()` runs unconditionally inside `openStores`, so the first boot
      // after the v6 upgrade applies the narrower bound to a database that was
      // filled under the wider one — and each row it cuts takes its whole
      // transcript with it. On a box that only ever had one person this is
      // silent because it never fires. On one that did not, it is the largest
      // irreversible thing this upgrade does, and it was the only part saying
      // nothing.
      if (excess.length > 0) {
        console.error(
          `Reemoat: pruned ${excess.length} session(s) over the ${options.maxSessions}-session cap, ` +
            "with their transcripts. Pinned sessions rank first and are kept; if this database was " +
            "written when the daemon served several people, that cap is now shared rather than per-person.",
        );
      }

      const removed = [...new Set([...stale, ...excess])];
      for (const id of removed) {
        this.removeEventsStmt.run(id);
        this.removeSessionStmt.run(id);
        this.lastWritten.delete(id);
      }
      // Events whose session row is gone: only reachable if a put() failed while
      // appends succeeded, or a remove() half-completed. A known, accepted loss.
      this.db.exec("DELETE FROM events WHERE session_id NOT IN (SELECT id FROM sessions)");
      // The same sweep for staged uploads, and it covers more than the rows just
      // deleted above: a database restored from a backup, or one whose session
      // rows were cut by an older build, leaves rows here with nothing to belong
      // to. The *files* are handled by the caller, from the returned list plus
      // the upload store's own reconciliation at open.
      this.db.exec("DELETE FROM uploads WHERE session_id NOT IN (SELECT id FROM sessions)");
      /*
       * ⚠ **And the same for what a plugin put here, which is the one child
       * table in this file that had no sweep.** Same shape as the two above — no
       * FOREIGN KEY, `PRAGMA foreign_keys = OFF` — and the same reachable cause,
       * except that here the two deletes are written in another file: `host.ts`
       * runs `records.remove(id)` and then `data.dropPlugin(id)` as two implicit
       * transactions with no BEGIN around them, in `doRemove` and again in the
       * install rollback. A throw from either, or a SIGKILL between them, or a
       * backup taken between them, strands up to `MAX_PLUGIN_KEYS` rows and
       * `MAX_PLUGIN_DATA_BYTES` per id.
       *
       * **Stranded here means stranded for ever**, which is what makes this
       * worse than the upload case: afterwards `installed()` is false on both
       * halves — no row, and the tree below the plugin root is gone — so `DELETE
       * /plugins/:id` answers 404 and nothing can reach `dropPlugin` again. And
       * they do not stay invisible: `plugin_data` is keyed on the id and never
       * on the version, deliberately so that an update keeps it, so the next
       * install of that id silently inherits somebody else's rows against its
       * own quota.
       *
       * **The subquery reads the table rather than `records.list()`**, and that
       * is `PluginRecordStore.has`'s distinction rather than a shortcut: a row
       * whose `manifest_json` this build cannot validate is reported through
       * `onDegraded` and omitted from `list`, and destroying its data would make
       * a daemon downgrade a data loss. A row is a row here. Nothing races it
       * either — `prune()` runs inside `openStores`, before `PluginHost` exists,
       * so no plugin is running and no half-written install is in flight.
       */
      this.db.exec("DELETE FROM plugin_data WHERE plugin_id NOT IN (SELECT id FROM plugins)");
      /*
       * ⚠ **A pasted credential is deliberately swept by nothing here, and this
       * is a reversal.** Both credential tables had an age-plus-emptiness sweep;
       * it is gone, and what is left is the route that put the value there —
       * `DELETE /agent-auth/:agent` and `DELETE /systems/:system`, plus a paste
       * that replaces one.
       *
       * The sweep's three stated reasons did not survive being read back:
       *
       *   - *"this daemon can never be told about a revocation"* is true and is
       *     not addressed by deleting the local copy. A leaked key is with
       *     whoever took it; revocation happens at the vendor.
       *   - *"the second recoverable secret in this file"* argues against itself.
       *     `identity.tunnel_key` is in the same file and there is no `DELETE FROM
       *     identity` anywhere, so the file holds a live secret regardless — and
       *     that one lets somebody be this machine on the relay.
       *   - *"a plaintext token outlived the last session"* couples two unrelated
       *     lifetimes. How long transcripts are kept is a storage question; how
       *     long a pasted key lives is "until it is replaced or removed", which is
       *     what `~/.claude/.credentials.json`, `~/.codex/auth.json` and
       *     `~/.ssh/id_ed25519` all answer, none of them self-expiring.
       *
       * What it cost was concrete. The age clause read `updated_at`, which moves
       * only on a paste, so it was permanently true of any key in real use and the
       * rule collapsed to `NOT EXISTS (SELECT 1 FROM sessions)` — eight idle days,
       * since unpinned sessions age out at seven. A machine put down over a
       * holiday came back with its tokens gone and nothing on screen saying why.
       *
       * The protection here is what it has always been and what the rest of this
       * file relies on: the 0700 directory and the 0600 file. See Q7.124.
       */
      this.db.exec("COMMIT");
      this.reclaim();
      return removed;
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back — the BEGIN itself failed.
      }
      return [];
    }
  }

  /**
   * Give the deleted pages back to the filesystem, sometimes.
   *
   * ⚠ **Pruning bounded the rows and nothing bounded the bytes.**
   * `.claude/rules/daemon-sessions.md` says "what bounds the database is whole
   * sessions: 7 days / 200, pruned at startup" — true of rows, and the file on
   * disk only ever grew. SQLite's `auto_vacuum` defaults to NONE and **cannot be
   * turned on for a database that already exists** without a full rebuild, so
   * every transcript this daemon has ever deleted is still occupying pages that
   * are merely marked free. On a machine running agents daily, against a table
   * whose rows are whole conversations and file diffs, that is the largest thing
   * on disk here.
   *
   * Three things make this safe to do at exactly this point and nowhere else:
   * `prune()` runs inside `openStores`, so `claimDaemonLock` has already refused
   * a second daemon; no listener is open, so no request is waiting; and `VACUUM`
   * cannot run inside a transaction, which is why it is after the `COMMIT` rather
   * than in it.
   *
   * **Only when it is worth the rewrite.** `VACUUM` copies the whole database, so
   * running it on every boot would put a full-size copy on the startup path of a
   * daemon that deleted nothing. A quarter of the file free is the trigger: high
   * enough that ordinary churn never reaches it, low enough that a fleet of
   * expired sessions does.
   *
   * Best-effort by construction. A failure here — no room for the copy, a
   * filesystem that will not — costs a database that is larger than it needs to
   * be, which is the state it was already in, and must never cost a daemon that
   * will not start.
   */
  private reclaim(): void {
    try {
      const free = Number(this.db.prepare("PRAGMA freelist_count").get()?.["freelist_count"] ?? 0);
      const total = Number(this.db.prepare("PRAGMA page_count").get()?.["page_count"] ?? 0);
      if (total === 0 || free / total < 0.25) return;
      this.db.exec("VACUUM");
    } catch {
      // See the docblock: a database that stays large is the status quo, and a
      // daemon that will not start is not.
    }
  }
}

/**
 * The index for staged uploads.
 *
 * Synchronous like every other store here, and for the same reason: node's SQLite
 * bindings are synchronous, so async would buy nothing and cost the argument. It
 * is safe to be synchronous *and* to be called from `ManagedSession.prompt`
 * because none of it is on the agent's emit path — `prompt` is a request handler
 * that answers 202, and the one place bytes are read is `pump`, which is already
 * async.
 */
export class SqliteUploadStore implements UploadIndex {
  private readonly insertStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly sumStmt: StatementSync;
  private readonly countStmt: StatementSync;
  private readonly consumeStmt: StatementSync;
  private readonly listForStmt: StatementSync;
  private readonly sessionsStmt: StatementSync;
  private readonly expiredStmt: StatementSync;
  private readonly removeStmt: StatementSync;
  private readonly removeSessionStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.insertStmt = db.prepare(
      // `consumed_at` is bound rather than hardcoded NULL, and that mattered: an
      // image the agent returned is inserted **already consumed**, because it is
      // referenced by an event the instant it exists. Writing NULL regardless
      // silently discarded that, so the 24-hour unconsumed sweep would have
      // deleted every agent image while the transcript went on pointing at it.
      "INSERT INTO uploads (session_id, upload_id, name, orig_name, mime, bytes, created_at, consumed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // Keyed on the pair, always. An upload id belonging to another session must
    // read as "no such upload" rather than as somebody else's file — the same
    // rule `sessionOf` follows one level up, and the reason the route can answer
    // 400 rather than having to decide between 403 and a leak.
    this.getStmt = db.prepare("SELECT * FROM uploads WHERE session_id = ? AND upload_id = ?");
    this.sumStmt = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM uploads WHERE session_id = ?");
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE session_id = ?");
    this.consumeStmt = db.prepare(
      "UPDATE uploads SET consumed_at = ? WHERE session_id = ? AND upload_id = ? AND consumed_at IS NULL",
    );
    this.listForStmt = db.prepare("SELECT * FROM uploads WHERE session_id = ? ORDER BY created_at");
    this.sessionsStmt = db.prepare("SELECT DISTINCT session_id FROM uploads");
    // Only the unconsumed expire on their own. A consumed upload is referenced by
    // a `prompt` event and dies with its session row instead.
    this.expiredStmt = db.prepare("SELECT * FROM uploads WHERE consumed_at IS NULL AND created_at < ?");
    this.removeStmt = db.prepare("DELETE FROM uploads WHERE session_id = ? AND upload_id = ?");
    this.removeSessionStmt = db.prepare("DELETE FROM uploads WHERE session_id = ?");
  }

  insert(row: UploadRow): void {
    this.insertStmt.run(
      row.sessionId,
      row.uploadId,
      row.name,
      row.origName,
      row.mime,
      row.bytes,
      row.createdAt,
      row.consumedAt,
    );
  }

  get(sessionId: string, uploadId: string): UploadRow | null {
    const row = this.getStmt.get(sessionId, uploadId);
    return row === undefined ? null : toUploadRow(row);
  }

  bytesFor(sessionId: string): number {
    return Number(this.sumStmt.get(sessionId)?.["total"] ?? 0);
  }

  countFor(sessionId: string): number {
    return Number(this.countStmt.get(sessionId)?.["n"] ?? 0);
  }

  /** Idempotent: an id named by a second prompt keeps the first timestamp. */
  markConsumed(sessionId: string, uploadIds: readonly string[], at: number): void {
    for (const id of uploadIds) this.consumeStmt.run(at, sessionId, id);
  }

  listFor(sessionId: string): UploadRow[] {
    return this.listForStmt.all(sessionId).map(toUploadRow);
  }

  listSessions(): string[] {
    return this.sessionsStmt.all().map((row) => String(row["session_id"]));
  }

  expired(createdBefore: number): UploadRow[] {
    return this.expiredStmt.all(createdBefore).map(toUploadRow);
  }

  remove(sessionId: string, uploadId: string): void {
    this.removeStmt.run(sessionId, uploadId);
  }

  removeSession(sessionId: string): void {
    this.removeSessionStmt.run(sessionId);
  }
}

function toUploadRow(row: Record<string, unknown>): UploadRow {
  const consumed = row["consumed_at"];
  return {
    sessionId: String(row["session_id"]),
    uploadId: String(row["upload_id"]),
    name: String(row["name"]),
    origName: String(row["orig_name"]),
    mime: row["mime"] === null || row["mime"] === undefined ? null : String(row["mime"]),
    bytes: Number(row["bytes"] ?? 0),
    createdAt: Number(row["created_at"] ?? 0),
    consumedAt: consumed === null || consumed === undefined ? null : Number(consumed),
  };
}

function toParams(row: PersistedSession): Record<string, string | number | null> {
  return {
    id: row.id,
    agent: row.agent,
    created_at: row.createdAt,
    updated_at: 0, // replaced at write time; excluded from the dirty-check key
    agent_session_id: row.agentSessionId,
    // Flattened into columns rather than stored as JSON: `agent_pid` already
    // existed and rows written by the local runtime keep exactly the shape they
    // had, so an older daemon reading this database still reaps its own orphans.
    agent_pid: row.agentHandle?.kind === "local" ? row.agentHandle.pid : null,
    container_id: row.agentHandle?.kind === "container" ? row.agentHandle.containerId : null,
    agent_pgid: row.agentHandle?.kind === "container" ? row.agentHandle.pgid : null,
    container_started_at:
      row.agentHandle?.kind === "container" ? row.agentHandle.containerStartedAt : null,
    status: row.status,
    exit_json: row.exit === null ? null : JSON.stringify(row.exit),
    turn_counter: row.turnCounter,
    last_event_at: row.lastEventAt,
    perm_seq: row.askSeq,
    perm_salt: row.askSalt,
    resume_gave_up: row.resumeGaveUp,
    last_seq: row.lastSeq,
    dropped: row.dropped,
    title: row.title,
    // SQLite has no boolean, and the dirty-check key is JSON of this object — so
    // the 1/0 form has to happen here rather than at the statement, or a `put`
    // that only flipped a pin would compare `true` against `1` and look dirty for
    // ever after.
    pinned: row.pinned ? 1 : 0,
    // Three-valued, so the same 1/0 conversion with NULL kept as NULL — that is
    // the state, not a missing value: nobody has chosen. See the column.
    ultracode: row.ultracode === null ? null : row.ultracode ? 1 : 0,
    // Absent from the DO UPDATE above, exactly as `agent` is and for the same
    // reason: what a session was started as is not something a later touch may
    // rewrite. Editing the preset changes what it resumes as; it cannot change
    // which preset it was.
    custom_agent: row.customAgent,
    workspace_json: JSON.stringify(row.workspace),
    workspace_mode: row.workspace.mode,
    workspace_root: row.workspace.root,
    workspace_branch: row.workspace.git?.branch ?? null,
    workspace_base: row.workspace.git?.baseCommit ?? null,
  };
}

/**
 * Rebuilds the agent handle from the four columns that can carry it.
 *
 * `container_id` is tested first and is the discriminator, not `agent_pgid`: a
 * pgid with no container to run it in cannot be signalled and must not be
 * mistaken for a host pid, which is exactly the confusion the union exists to
 * prevent. A row missing either of the other container fields is treated as
 * having no handle at all — half a handle is not a weaker handle, it is one that
 * would signal the wrong thing.
 */
function toHandle(row: Record<string, unknown>): AgentHandle | null {
  const containerId = row["container_id"];
  if (containerId != null) {
    // **Read-only legacy, and validated anyway.** Nothing writes this arm any
    // more — it is what a row from the multi-tenant daemon still carries, and
    // `LocalRuntime.reap` reports such a handle as one it will not signal rather
    // than guessing at a number in a namespace that no longer exists. There is
    // therefore no write path left to trust, which is the stronger reason to
    // check the values here rather than a weaker one: the database is
    // deliberately readable and writable by the `sqlite3` CLI, so it was never a
    // trusted input, and now nothing upstream is validating it either.
    //
    // A pgid of 0 or 1 is refused along with the rest: 0 is "this process group"
    // and 1 is init's, and neither can be a recorded agent.
    const pgid = toPositiveInt(row["agent_pgid"], 2);
    const startedAt = toPositiveInt(row["container_started_at"], 1);
    if (pgid === null || startedAt === null) return null;
    return {
      kind: "container",
      containerId: String(containerId),
      pgid,
      containerStartedAt: startedAt,
    };
  }
  const pid = toPositiveInt(row["agent_pid"], 2);
  return pid === null ? null : { kind: "local", pid };
}

/** An integer at or above `min`, or `null` for anything else — `NaN` included. */
function toPositiveInt(value: unknown, min: number): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : null;
}

/**
 * Repairs an exit record written before the agent handle was a union.
 *
 * `SessionExit.agentPid` became `agentHandle` in v4, but exit records live as an
 * unvalidated JSON blob in `sessions.exit_json` and the column migration cannot
 * reach inside one. Left alone, every pre-v4 row deserializes with
 * `agentHandle: undefined` — not `null`, which is what the type promises and
 * what `packages/web` declares as a required field — while the dead `agentPid`
 * rides along and is re-serialized verbatim on the next touch, so the blob never
 * heals.
 *
 * Converting rather than dropping keeps the fact the field was recorded for: a
 * pid from a daemon that predates containers really was a local one.
 */
function normalizeExit(value: unknown): SessionExit | null {
  if (value === null || typeof value !== "object") return null;
  const exit = value as SessionExit & { agentPid?: unknown };
  if (exit.agentHandle === undefined) {
    const pid = toPositiveInt(exit.agentPid, 2);
    exit.agentHandle = pid === null ? null : { kind: "local", pid };
  }
  delete exit.agentPid;
  return exit;
}

function fromRow(row: Record<string, unknown>): PersistedSession | null {
  try {
    const workspace = JSON.parse(String(row["workspace_json"])) as SessionWorkspace;
    if (typeof workspace?.root !== "string") return null;
    /*
     * ⚠ **Validated, where it used to be cast — this is Q7.31's named
     * precondition and it is reached now.**
     *
     * The line was `String(row["agent"]) as AgentId`, while `isAgentId` guarded
     * the HTTP boundary — so the *only* unchecked door into the union was the
     * one a restart walks through. A row naming an agent no longer in the union
     * came back as a well-typed value and failed in `resolveAgent`, at which
     * point a worktree had already been made. Adding an agent never reached
     * that; removing or renaming one does, and so does a database written by a
     * build that knew a fourth.
     *
     * Dropped rather than repaired, which is what returning `null` already means
     * here for a row with no workspace: there is no honest substitute for an
     * agent, and guessing one would resume somebody's conversation under a
     * different model.
     *
     * ⚠ **Shape, not membership, and the two are not interchangeable here.** A
     * harness a plugin added passes {@link isContributedId} whether or not that
     * plugin is currently installed, switched on, or even readable — because this
     * runs at boot, before anything is on screen, and a membership test would
     * delete every session on a harness whose plugin somebody switched off an hour
     * ago. What refuses such a session is `resolveAgent`, at launch, with a
     * sentence naming the plugin; the conversation is still there when it comes
     * back. The original rule is untouched for the four this repository ships: a
     * built-in that is renamed or removed still drops, which is the case Q7.31
     * named and the only one where there is nothing to come back to.
     */
    const agent = String(row["agent"]);
    if (!isBuiltinAgentId(agent) && !isContributedId(agent)) return null;
    const exitJson = row["exit_json"];
    return {
      id: String(row["id"]),
      agent,
      createdAt: Number(row["created_at"] ?? 0),
      // `?? null` and not `String(...)`: the column is NULL for every session
      // written before v2, and coercing that would invent an owner named "null".
      workspace,
      agentSessionId: row["agent_session_id"] === null ? null : String(row["agent_session_id"]),
      agentHandle: toHandle(row),
      status: String(row["status"]) as SessionStatus,
      exit: exitJson === null ? null : normalizeExit(JSON.parse(String(exitJson))),
      turnCounter: Number(row["turn_counter"] ?? 0),
      lastEventAt: row["last_event_at"] === null ? null : Number(row["last_event_at"]),
      // `perm_*` on disk, `ask*` in TypeScript — see the comment at the columns.
      askSeq: Number(row["perm_seq"] ?? 0),
      askSalt: String(row["perm_salt"] ?? ""),
      resumeGaveUp: row["resume_gave_up"] === null || row["resume_gave_up"] === undefined ? null : String(row["resume_gave_up"]),
      lastSeq: Number(row["last_seq"] ?? 0),
      dropped: Number(row["dropped"] ?? 0),
      // `== null` for the same reason `owner` above uses it: the column is NULL
      // for every session written before v5, and `String(null)` would invent a
      // session named "null" and render it as the row's label.
      title: row["title"] == null ? null : String(row["title"]),
      pinned: Number(row["pinned"] ?? 0) !== 0,
      // `== null` covers both NULL on disk and a column an older database does
      // not have at all, and both mean the same thing here: nobody chose, so
      // this session follows the machine's setting.
      ultracode: row["ultracode"] == null ? null : Number(row["ultracode"]) !== 0,
      // `== null` covers both NULL and a column an older file does not have.
      customAgent: row["custom_agent"] == null ? null : String(row["custom_agent"]),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Identity
 * ------------------------------------------------------------------------- */

/** What enrollment produced, as it is stored. */
/** One credential a tenant supplied, as it will be handed to their agent. */
export interface AgentCredential {
  agent: string;
  /** The environment variable the agent's CLI reads it from. */
  envName: string;
  updatedAt: number;
}

/**
 * Agent credentials, per tenant.
 *
 * Deliberately never hands the secret back out through a method a route could
 * reach by accident: `list` returns metadata and `envFor` returns a ready-made
 * environment map for a `docker exec`. There is no `get(agent) -> string`,
 * because the only correct destination for one of these is an agent process, and
 * a getter is how it ends up in a response body instead.
 *
 * Synchronous like every other store here — node:sqlite is synchronous, so async
 * would buy nothing and cost the argument that the emit path never awaits.
 */
export class SqliteAgentCredentialStore {
  private readonly listStmt: StatementSync;
  private readonly envStmt: StatementSync;
  private readonly saveStmt: StatementSync;
  private readonly deleteStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.listStmt = db.prepare(
      "SELECT agent, env_name, updated_at FROM agent_credentials ORDER BY agent, env_name",
    );
    this.envStmt = db.prepare("SELECT env_name, secret FROM agent_credentials WHERE agent = ?");
    this.saveStmt = db.prepare(
      "INSERT INTO agent_credentials (agent, env_name, secret, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(agent, env_name) DO UPDATE SET secret = excluded.secret, " +
        "updated_at = excluded.updated_at",
    );
    this.deleteStmt = db.prepare("DELETE FROM agent_credentials WHERE agent = ? AND env_name = ?");
  }

  list(): AgentCredential[] {
    return this.listStmt.all().map((row) => ({
      agent: String(row["agent"]),
      envName: String(row["env_name"]),
      updatedAt: Number(row["updated_at"] ?? 0),
    }));
  }

  /** What to inject into the agent's process. Empty when none was pasted. */
  envFor(agent: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of this.envStmt.all(agent)) {
      env[String(row["env_name"])] = String(row["secret"]);
    }
    return env;
  }

  save(agent: string, envName: string, secret: string): void {
    this.saveStmt.run(agent, envName, secret, Date.now());
  }

  remove(agent: string, envName: string): void {
    this.deleteStmt.run(agent, envName);
  }
}

/** One system's key, as metadata. The secret itself is never in this shape. */
export interface SystemCredential {
  system: SystemId;
  updatedAt: number;
}

/**
 * Keys for the systems a harness can be pointed at.
 *
 * ⚠ **`get` exists here where {@link SqliteAgentCredentialStore} deliberately
 * has no getter, and the asymmetry is the design.** That class refuses one
 * because the only correct destination for an agent credential is a process
 * environment, and a `get(agent) -> string` is how it ends up in a response body
 * instead. A system credential's only correct destination is `providers/set`'s
 * headers, which is a *value* rather than an environment — so it has to be
 * readable, and what protects it is that the one caller is `LocalRuntime.
 * systemSecret` and there is no route that reaches this.
 *
 * `list` is what a route may have: metadata, never the secret.
 */
export class SqliteSystemCredentialStore {
  private readonly listStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly saveStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly onDegraded: ((detail: string) => void) | undefined;

  constructor(db: DatabaseSync, onDegraded?: (detail: string) => void) {
    this.onDegraded = onDegraded;
    this.listStmt = db.prepare("SELECT system, updated_at FROM system_credentials ORDER BY system");
    this.getStmt = db.prepare("SELECT secret FROM system_credentials WHERE system = ?");
    this.saveStmt = db.prepare(
      "INSERT INTO system_credentials (system, secret, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(system) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at",
    );
    this.deleteStmt = db.prepare("DELETE FROM system_credentials WHERE system = ?");
  }

  list(): SystemCredential[] {
    // Validated on the way out for `fromRow`'s reason: the column is plain text
    // and a row written by a build that knew more systems than this one must not
    // become a well-typed value naming one this build cannot resolve.
    return this.listStmt.all().flatMap((row) => {
      const system = String(row["system"]);
      // Shape rather than membership, for the reason `readCustomAgent` gives:
      // a key saved for a provider whose plugin is switched off is still that
      // person's key, and dropping it from the listing would make the one control
      // that can delete it disappear at the moment it matters most.
      if (isBuiltinSystemId(system) || isContributedId(system)) {
        return [{ system, updatedAt: Number(row["updated_at"] ?? 0) }];
      }
      /*
       * Reported rather than merely dropped, for `SqliteSessionStore.list`'s
       * reason: "the key disappears from a list" is visible only to somebody who
       * remembers saving it, and this row is a plaintext secret. `DELETE
       * /systems/:system` can still remove it — it removes before it validates,
       * exactly so this state is not a strand — and since Q7.124 that route is the
       * *only* thing that will: `prune()` names neither credential table, so
       * nothing ages this row out. The line is what tells an operator it is there.
       */
      this.onDegraded?.(
        `a key is stored for system ${JSON.stringify(system)}, which this build ` +
          "does not know: it cannot be used, and DELETE /systems/:system will clear it",
      );
      return [];
    });
  }

  get(system: SystemId): string | null {
    const row = this.getStmt.get(system);
    return row === undefined ? null : String(row["secret"]);
  }

  save(system: SystemId, secret: string): void {
    this.saveStmt.run(system, secret, Date.now());
  }

  remove(system: SystemId): void {
    this.deleteStmt.run(system);
  }
}

/**
 * The agents somebody assembled on this machine.
 *
 * ⚠ **Every read validates `harness` and `system`, and a row failing either is
 * dropped rather than repaired.** Same rule and same reason as `fromRow`: there
 * is no honest substitute for a harness, and guessing one would start somebody's
 * session on a different model than its name promises. Dropping is visible — the
 * preset disappears from a list — where a guess is not.
 */
export class SqliteCustomAgentStore {
  private readonly listStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly saveStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly onDegraded: ((detail: string) => void) | undefined;

  constructor(db: DatabaseSync, onDegraded?: (detail: string) => void) {
    this.onDegraded = onDegraded;
    const columns = "id, name, harness, system, model, created_at";
    this.listStmt = db.prepare(`SELECT ${columns} FROM custom_agents ORDER BY created_at, id`);
    this.getStmt = db.prepare(`SELECT ${columns} FROM custom_agents WHERE id = ?`);
    /*
     * An upsert, and it was a bare `INSERT` for as long as a preset was
     * write-once — which is why nothing had ever saved the same id twice.
     * `PATCH /custom-agents/:id` reconstructs the whole row and hands it back
     * under the id it already had, so against the bare insert every edit came
     * back `500 internal_error` out of `SQLITE_CONSTRAINT_PRIMARYKEY`. The route
     * section of `daemoncheck` stands a `Map` in for this port and `Map.set` is
     * an upsert by construction, so that half saw nothing; only the real store
     * can say it.
     *
     * `created_at` is deliberately absent from the update list. The age of a
     * preset is the one thing about it that is not somebody's to change, and a
     * caller of this port that gets it wrong — the route is such a caller by
     * design, since it rebuilds the row rather than patching columns — must not
     * be able to move it.
     */
    this.saveStmt = db.prepare(
      `INSERT INTO custom_agents (${columns}) VALUES (?, ?, ?, ?, ?, ?) ` +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, harness = excluded.harness, " +
        "system = excluded.system, model = excluded.model",
    );
    this.deleteStmt = db.prepare("DELETE FROM custom_agents WHERE id = ?");
  }

  list(): CustomAgent[] {
    return this.listStmt.all().flatMap((row) => {
      const one = readCustomAgent(row);
      if (one !== null) return [one];
      // Recoverable — somebody can assemble it again — so this is a line rather
      // than the stronger sentence the session store writes. It is still said,
      // because "you never made one" and "the row is here and unreadable" look
      // identical on the screen that lists them.
      this.onDegraded?.(
        `assembled agent ${String(row["id"])} names harness ` +
          `${JSON.stringify(String(row["harness"]))} and system ` +
          `${JSON.stringify(String(row["system"]))}, and this build cannot resolve both`,
      );
      return [];
    });
  }

  get(id: string): CustomAgent | null {
    const row = this.getStmt.get(id);
    return row === undefined ? null : readCustomAgent(row);
  }

  save(one: CustomAgent): void {
    this.saveStmt.run(one.id, one.name, one.harness, one.system, one.model, one.createdAt);
  }

  remove(id: string): void {
    this.deleteStmt.run(id);
  }
}

/**
 * A preset, or `null` for a row this build cannot honestly resolve.
 *
 * ⚠ **Shape rather than membership, for `fromRow`'s reason and one of its own.**
 * This runs inside `restore()`, through `ManagedSession.assembled`, on every boot
 * — so a membership test would mean that installing a plugin and restarting the
 * daemon in the wrong order silently un-assembles every preset built on it, and
 * every session on those presets would come back demoted to the bare harness its
 * `agent` column names. What refuses an unrunnable pairing is the launch, which
 * has the live catalogue and answers a sentence.
 *
 * The refusal that stays is the one Q7.31 asked for: a row naming something with
 * no possible id at all is dropped rather than cast.
 */
function readCustomAgent(row: Record<string, unknown>): CustomAgent | null {
  const harness = String(row["harness"]);
  const system = String(row["system"]);
  if (!isBuiltinAgentId(harness) && !isContributedId(harness)) return null;
  if (!isBuiltinSystemId(system) && !isContributedId(system)) return null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    harness,
    system,
    model: String(row["model"]),
    createdAt: Number(row["created_at"] ?? 0),
  };
}

/**
 * Which agents the New session strip offers here, and in what order.
 *
 * ⚠ **A partial record over a list it does not own.** Nothing here knows what a
 * harness or an assembled agent is; a row is a `(kind, ref)` somebody moved or
 * switched off, and what the strip draws is this list merged against what the
 * machine currently offers. So an agent this table has never heard of is
 * *visible and last*, which is the only default that cannot surprise anybody —
 * a new agent arriving pre-hidden reads as the daemon losing it.
 *
 * ⚠ **No validation of `ref`, deliberately, and it is the opposite call from
 * `readCustomAgent` directly above.** That one drops a row naming a harness this
 * build cannot resolve, because restoring it would produce a well-typed lie that
 * fails later with a worktree already made. Here the row *is* the memory and
 * resolving is the reader's job: dropping the position of an agent that happens
 * to be signed out today would rearrange somebody's screen the moment they signed
 * out, and put it somewhere else again when they signed back in.
 */
export class SqliteAgentStripStore {
  private readonly db: DatabaseSync;
  private readonly listStmt: StatementSync;
  private readonly clearStmt: StatementSync;
  private readonly insertStmt: StatementSync;
  private readonly forgetStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.listStmt = db.prepare(
      "SELECT kind, ref, hidden FROM agent_strip ORDER BY rank, kind, ref",
    );
    this.clearStmt = db.prepare("DELETE FROM agent_strip");
    this.insertStmt = db.prepare(
      "INSERT INTO agent_strip (kind, ref, rank, hidden) VALUES (?, ?, ?, ?)",
    );
    this.forgetStmt = db.prepare("DELETE FROM agent_strip WHERE kind = ? AND ref = ?");
  }

  /**
   * The remembered order.
   *
   * `ORDER BY rank` first, then `kind, ref` — the tie-break is not decoration.
   * `rank` is the caller's array index and is therefore unique on every list this
   * daemon writes, but the column carries no constraint saying so, and a file
   * hand-edited or written by some future build must still come back in *one*
   * order rather than in whatever order SQLite felt like. An unstable list here
   * is a strip that shuffles itself between reads.
   */
  list(): AgentStripEntry[] {
    return this.listStmt.all().flatMap((row) => {
      const kind = String(row["kind"]);
      // The one thing that *is* checked, because it is this daemon's own
      // vocabulary rather than somebody's agent id, and a third value would reach
      // a `switch` in the client that has no arm for it.
      if (kind !== "harness" && kind !== "custom") return [];
      return [{ kind, ref: String(row["ref"]), hidden: Number(row["hidden"] ?? 0) !== 0 }];
    });
  }

  /**
   * Replace the whole strip.
   *
   * ⚠ **The transaction is for atomicity here, unlike the one in `prune`.** That
   * one wraps statements that are each already correct on their own and takes the
   * transaction only to spend one WAL commit; this one empties the table before it
   * refills it, so a failure part-way through without a `ROLLBACK` is somebody's
   * order deleted by an act that reported an error. The throw is re-raised rather
   * than swallowed — the route above turns it into a 500, and the screen restores
   * what it drew.
   */
  replace(entries: readonly AgentStripEntry[]): void {
    this.db.exec("BEGIN");
    try {
      this.clearStmt.run();
      for (const [rank, one] of entries.entries()) {
        this.insertStmt.run(one.kind, one.ref, rank, one.hidden ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back — the BEGIN itself failed.
        //
        // ⚠ The other way `BEGIN` can fail is *already inside a transaction*, and
        // there the `ROLLBACK` would succeed and discard the outer one's work
        // instead. Not reachable: this method has one caller, `PUT /agent-strip`,
        // and no route on this daemon opens a transaction around a handler. Said
        // out loud because the remedy if one ever does is a savepoint rather than
        // a wider catch.
      }
      throw error;
    }
  }

  /**
   * Drop one position, for the write that is not the screen.
   *
   * Deleting an assembled agent takes its row with it. The merge would ignore the
   * orphan anyway — it resolves to nothing — so this is not correctness; it is the
   * only thing standing between this table and unbounded growth on a machine where
   * presets are made and thrown away and the strip screen is never opened.
   */
  forget(kind: AgentStripEntry["kind"], ref: string): void {
    this.forgetStmt.run(kind, ref);
  }
}


export interface StoredIdentity {
  machineId: string;
  issuer: string;
  keys: { kid: string; jwk: unknown }[];
  controlPlane: string;
  /** Fingerprint of the redeemed enrollment code, never the code itself. */
  codeFp: string;
  enrolledAt: number;
  /**
   * The relay tunnel credential, or `null` if the control plane offered none.
   *
   * The one live secret this daemon keeps on disk — everything else in this row
   * is public. It sits in the same 0600 file inside the same 0700 directory as
   * the transcripts, which is already the strictest thing available here; a
   * separate file would add a second thing to get the permissions right on
   * without adding a second protection.
   */
  tunnelKey: string | null;
  /** Where to dial for a tunnel, or `null` for a control plane running no relay. */
  relayUrl: string | null;
}

/**
 * The single row this daemon keeps about who it is.
 *
 * Unlike the session and event stores, nothing here is on a hot path — it is
 * read once at startup and written once per enrollment — so these methods
 * throw rather than swallow. A daemon that cannot read its own identity must
 * not come up pretending it has none: that would silently re-enroll, or worse,
 * start refusing every token that was fine a moment ago.
 */
export class SqliteIdentityStore {
  private readonly loadStmt: StatementSync;
  private readonly saveStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.loadStmt = db.prepare("SELECT * FROM identity WHERE id = 1");
    this.saveStmt = db.prepare(
      "INSERT INTO identity (id, machine_id, issuer, keys_json, control_plane, code_fp, enrolled_at, " +
        "tunnel_key, relay_url) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET machine_id = excluded.machine_id, issuer = excluded.issuer, " +
        "keys_json = excluded.keys_json, control_plane = excluded.control_plane, " +
        "code_fp = excluded.code_fp, enrolled_at = excluded.enrolled_at, " +
        "tunnel_key = excluded.tunnel_key, relay_url = excluded.relay_url",
    );
  }

  load(): StoredIdentity | null {
    const row = this.loadStmt.get();
    if (!row) return null;
    const keys: unknown = JSON.parse(String(row["keys_json"]));
    if (!Array.isArray(keys)) {
      throw new Error("the stored machine identity has an unreadable key set");
    }
    return {
      machineId: String(row["machine_id"]),
      issuer: String(row["issuer"]),
      keys: keys as { kid: string; jwk: unknown }[],
      controlPlane: String(row["control_plane"]),
      codeFp: String(row["code_fp"]),
      enrolledAt: Number(row["enrolled_at"] ?? 0),
      tunnelKey: row["tunnel_key"] == null ? null : String(row["tunnel_key"]),
      relayUrl: row["relay_url"] == null ? null : String(row["relay_url"]),
    };
  }

  save(identity: StoredIdentity): void {
    this.saveStmt.run(
      identity.machineId,
      identity.issuer,
      JSON.stringify(identity.keys),
      identity.controlPlane,
      identity.codeFp,
      identity.enrolledAt,
      identity.tunnelKey,
      identity.relayUrl,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */


/** Wall-clock time of the last boot. Pids from before it may have been recycled. */
function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Is a process with this pid running, for the purpose of the lock above?
 *
 * A deliberate **two**-answer probe, unlike `runtime/local.ts`'s, and the
 * difference is worth stating because the two look identical and answer different
 * questions. There, `EPERM` means "that pid is somebody else's now", so treating
 * it as dead would let a reaper SIGKILL a stranger. Here it means the same thing,
 * and the consequence is the opposite: the daemon that wrote this row was ours,
 * by construction — the file lives under our own `HOME` — so a pid we cannot
 * signal is a pid that has been recycled away from it, i.e. our daemon is gone
 * and the lock is free.
 *
 * The `startedAt >= bootTime()` fence in front of this is what makes that
 * reasoning safe: a row from before the last boot is not consulted at all.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` is "recycled to another user", which for this question is free.
    return (error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM"
      ? true
      : false;
  }
}

/**
 * What is installed, durably.
 *
 * The manifest is stored whole and **re-validated on every read**, which is the
 * one thing worth arguing here. A row could have been written by a build that
 * knew a manifest field this one does not, or by a build whose validation was
 * looser; parsing it back through `parseManifest` means such a row is refused as
 * a plugin — reported once and skipped — rather than half-understood as a set of
 * fields, which is exactly what a column-per-field schema would silently produce.
 *
 * The degradation is reported through `onDegraded` because it is the same kind of
 * fact that sink already carries: something durable is not what this build
 * expects, nobody is at the keyboard, and the alternative is silence.
 */
export class SqlitePluginRecordStore implements PluginRecordStore {
  private readonly listStmt: StatementSync;
  private readonly getStmt: StatementSync;
  private readonly hasStmt: StatementSync;
  private readonly putStmt: StatementSync;
  private readonly enableStmt: StatementSync;
  private readonly removeStmt: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly onDegraded: ((detail: string) => void) | undefined = undefined,
  ) {
    this.listStmt = db.prepare("SELECT * FROM plugins ORDER BY id");
    this.getStmt = db.prepare("SELECT * FROM plugins WHERE id = ?");
    /*
     * `SELECT 1` and never `SELECT *`, because this is the one question about a
     * row that must not go through `toRecord`: a manifest this build cannot
     * validate is exactly the case `has` exists to answer for, and re-parsing it
     * to find out whether it is there would answer "no" for a row that is. It
     * also means asking costs an index probe rather than a JSON parse.
     */
    this.hasStmt = db.prepare("SELECT 1 FROM plugins WHERE id = ?");
    // One row per plugin, so an update is a replace. `installed_at` rides the
    // parameter list rather than being preserved by the statement, because the
    // caller is the only thing that knows whether this is a first install.
    this.putStmt = db.prepare(
      "INSERT INTO plugins (id, version, manifest_json, enabled, installed_at, updated_at, source) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json, " +
        "enabled = excluded.enabled, updated_at = excluded.updated_at, source = excluded.source",
    );
    // `installed_at` is deliberately absent from the DO UPDATE, for the reason
    // `agent`/`created_at` are absent from the sessions upsert: it is immutable
    // identity, and an upsert able to rewrite it can corrupt a row it was only
    // meant to touch.
    this.enableStmt = db.prepare("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?");
    this.removeStmt = db.prepare("DELETE FROM plugins WHERE id = ?");
  }

  list(): InstalledPlugin[] {
    const out: InstalledPlugin[] = [];
    for (const row of this.listStmt.all()) {
      const record = this.toRecord(row);
      if (record !== null) out.push(record);
    }
    return out;
  }

  get(id: string): InstalledPlugin | null {
    const row = this.getStmt.get(id);
    return row === undefined ? null : this.toRecord(row);
  }

  has(id: string): boolean {
    // No `onDegraded` here even though this is the method that can see a row
    // `get` reported on: the same row is reported every time it is read, and a
    // caller asking whether something exists must not be a second source of the
    // same sentence.
    return this.hasStmt.get(id) !== undefined;
  }

  put(record: InstalledPlugin): void {
    this.putStmt.run(
      record.id,
      record.version,
      JSON.stringify(record.manifest),
      record.enabled ? 1 : 0,
      record.installedAt,
      record.updatedAt,
      record.source,
    );
  }

  setEnabled(id: string, enabled: boolean, now: number): void {
    this.enableStmt.run(enabled ? 1 : 0, now, id);
  }

  remove(id: string): void {
    this.removeStmt.run(id);
  }

  private toRecord(row: Record<string, unknown>): InstalledPlugin | null {
    const id = String(row["id"] ?? "");
    const parsed = parseManifest(String(row["manifest_json"] ?? ""));
    if (!parsed.ok) {
      this.onDegraded?.(`plugin ${id} is on disk with a manifest this build cannot read: ${parsed.message}`);
      return null;
    }
    return {
      id,
      version: String(row["version"] ?? ""),
      manifest: parsed.manifest,
      enabled: Number(row["enabled"] ?? 0) !== 0,
      installedAt: Number(row["installed_at"] ?? 0),
      updatedAt: Number(row["updated_at"] ?? 0),
      source: row["source"] === null || row["source"] === undefined ? null : String(row["source"]),
    };
  }
}

/**
 * What plugins have put here.
 *
 * The quota is read and applied in one synchronous stretch — the running pair,
 * the replaced row's length, `checkPluginWrite`, insert — which is safe for the
 * reason everything else in this file is: `node:sqlite` is synchronous, so there
 * is no `await` between the read and the write for a second caller to interleave
 * into. That is also what makes the running pair legitimate rather than a cache
 * that can be wrong: nothing can write between the adjustment and the statement
 * it describes.
 *
 * `checkPluginWrite` lives in `src/plugins/store.ts` rather than here, so that
 * `daemoncheck`'s in-memory implementation refuses exactly what this one refuses.
 * A quota that holds only where there is a file is a quota nothing drives.
 */
export class SqlitePluginDataStore implements PluginDataStore {
  private readonly getStmt: StatementSync;
  private readonly sizeStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly keysStmt: StatementSync;
  private readonly entriesStmt: StatementSync;
  private readonly dropStmt: StatementSync;
  private readonly usageStmt: StatementSync;
  /**
   * `(keys, bytes)` per plugin, carried forward instead of recomputed.
   *
   * ⚠ **`set` used to run the `COUNT(*), SUM(...)` below on every single write,
   * and that made filling a store quadratic.** The primary key is
   * `(plugin_id, key)` and does not cover `value`, so the sum is a full walk of
   * the plugin's rows *plus* a table fetch of every value — up to the 1 MiB
   * `MAX_PLUGIN_DATA_BYTES` allows, per write, synchronously, on the event loop
   * that also owns every session and the tunnel. Measured on Node 26 against
   * `schema.sql` itself, filling one store with ~1 KiB values one write at a
   * time: **250 keys 3.3 ms → 0.6 ms, 500 keys 11.7 ms → 1.2 ms, 1000 keys
   * 42.9 ms → 2.3 ms.** The ratio is the small part of that — the shape is the
   * point: doubling the row count roughly quadrupled the old time and roughly
   * doubled the new one, which is what "quadratic" reads like from outside.
   * 1000 is `MAX_PLUGIN_KEYS`, so it is the ceiling rather than an unfair case.
   *
   * Seeded once per plugin from the same query and then moved by
   * `size - (existing ?? 0)`, which is the delta `checkPluginWrite` is already
   * handed. Every mutation in this class adjusts it — `set`, `delete` and
   * `dropPlugin` — so the invariant is "it agrees with the table", not "it agrees
   * with the last seed". `dropPlugin` **forgets** the entry rather than zeroing
   * it, so the next touch reseeds from the table: the one shape that is still
   * right if a row survived the drop, which `prune`'s orphan sweep exists because
   * it can.
   */
  private readonly usage = new Map<string, { keys: number; bytes: number }>();

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT value FROM plugin_data WHERE plugin_id = ? AND key = ?");
    // What the replaced row costs, without paying to carry it back. `set` used
    // to read the whole value through `getStmt` and measure it with
    // `Buffer.byteLength` — up to `MAX_PLUGIN_VALUE_BYTES` of TEXT off the table
    // to learn one integer. The `LENGTH(CAST(... AS BLOB))` is the same
    // expression `usageStmt` sums, so the credit-back cannot disagree with the
    // seed the way a JS-side count and a SQL-side sum could.
    this.sizeStmt = db.prepare(
      "SELECT LENGTH(CAST(value AS BLOB)) AS bytes FROM plugin_data WHERE plugin_id = ? AND key = ?",
    );
    this.setStmt = db.prepare(
      "INSERT INTO plugin_data (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    /*
     * `RETURNING` so the credit back to `usage` costs no second statement, and
     * safe here for a reason that is about this `WHERE` rather than about
     * `RETURNING`: it names the whole primary key, so at most one row can match
     * and `get()`'s single step is the whole statement. Measured on Node 26 —
     * the row is gone afterwards, a missing key answers `undefined` and deletes
     * nothing, and the statement resets clean for the next call. ⚠ **Widening
     * that `WHERE` would break this**, because `get()` stops at the first row;
     * `dropStmt` below is many rows and deliberately does not do this.
     */
    this.deleteStmt = db.prepare(
      "DELETE FROM plugin_data WHERE plugin_id = ? AND key = ? " +
        "RETURNING LENGTH(CAST(value AS BLOB)) AS bytes",
    );
    /*
     * ⚠ **A binary range rather than `LIKE`, because `LIKE` is not case
     * sensitive and this column is.** SQLite folds ASCII in `LIKE` by default
     * while `PRIMARY KEY (plugin_id, key)` collates BINARY, so the two disagreed
     * about what a prefix is: measured against this exact DDL, `LIKE 'card:%'`
     * answered `['CARD:3', 'Card:2', 'card:1']` where the plugin had asked for
     * one namespace and `card:1` was the only row in it. Those are genuinely
     * distinct rows a plugin can hold at once, so this was handing back other
     * people's keys — and `daemoncheck`'s in-memory store filters with
     * `startsWith`, which is case sensitive, so the parity assertion between the
     * two passed only because every fixture key is lower case.
     *
     * `key >= :from AND key < :upto` is the same comparison the index is built
     * on, so it is also the form SQLite can seek rather than scan, and it needs
     * no escape discipline: `%` and `_` are ordinary characters to `<`.
     */
    this.keysStmt = db.prepare(
      "SELECT key FROM plugin_data WHERE plugin_id = ? AND key >= ? AND (? IS NULL OR key < ?) ORDER BY key",
    );
    /*
     * The same range and the same bounds, widened to the value and given a
     * cursor. Kept as its own statement rather than widening `keysStmt` to
     * `SELECT key, value`: `keys` is still the right call for a plugin that wants
     * names, and reading every value to answer it would make the cheap call pay
     * for the batched one. `key > ?` is what makes a page a page — a keyset
     * cursor rather than `LIMIT/OFFSET`, so a plugin writing to its own store
     * between two pages cannot make the second one skip a row or repeat one.
     */
    this.entriesStmt = db.prepare(
      "SELECT key, value FROM plugin_data WHERE plugin_id = ? AND key >= ? AND (? IS NULL OR key < ?) AND key > ? ORDER BY key",
    );
    this.dropStmt = db.prepare("DELETE FROM plugin_data WHERE plugin_id = ?");
    this.usageStmt = db.prepare(
      // `CAST(... AS BLOB)` because bare `LENGTH` on TEXT counts characters, and the
      // quota this feeds is in bytes. `checkPluginWrite` charges `Buffer.byteLength`
      // against it, so both sides now count the same thing.
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes FROM plugin_data WHERE plugin_id = ?",
    );
  }

  get(pluginId: string, key: string): unknown {
    const row = this.getStmt.get(pluginId, key);
    return row === undefined ? null : parseStored(String(row["value"]));
  }

  set(pluginId: string, key: string, value: string): void {
    const usage = this.usageOf(pluginId);
    const existing = this.sizeOf(pluginId, key);
    // Throws before anything is written, and before `usage` is moved — so a
    // refusal leaves the pair describing the table exactly as it did.
    checkPluginWrite(key, value, { keys: usage.keys, bytes: usage.bytes, existing });
    this.setStmt.run(pluginId, key, value, Date.now());
    // The same arithmetic `checkPluginWrite` just did, applied rather than
    // predicted: it charges `Buffer.byteLength(value)` against the credited-back
    // `existing`, and the row now holds those exact bytes.
    usage.bytes += Buffer.byteLength(value, "utf8") - (existing ?? 0);
    if (existing === null) usage.keys += 1;
  }

  delete(pluginId: string, key: string): void {
    /*
     * ⚠ **Seeded before the statement runs, and the order is the whole of it.**
     * A first touch that is a `delete` — a restarted plugin clearing a key it
     * wrote in a previous daemon life — would otherwise seed `usage` from a
     * table the delete had *already* changed, and then subtract the same row a
     * second time. Measured against `schema.sql` with sixteen 64 KiB values,
     * i.e. `MAX_PLUGIN_DATA_BYTES` exactly: a fresh store deleting one of them
     * and then writing back accepted **two** 64 KiB values rather than one, and
     * left 1,114,112 bytes under a 1,048,576-byte ceiling. A quota that a
     * restart widens is not a quota.
     */
    const usage = this.usageOf(pluginId);
    const row = this.deleteStmt.get(pluginId, key);
    // `undefined` means there was no such row, and then nothing moved — deleting
    // a key a plugin never wrote must not credit it a key it never spent.
    if (row === undefined) return;
    usage.keys -= 1;
    usage.bytes -= Number(row["bytes"] ?? 0);
  }

  keys(pluginId: string, prefix: string): string[] {
    const [from, upto] = range(prefix);
    return this.keysStmt.all(pluginId, from, upto, upto).map((row) => String(row["key"]));
  }

  entries(pluginId: string, prefix: string, after: string, maxBytes: number): PluginEntryPage {
    const entries: PluginEntry[] = [];
    let bytes = 0;
    let more = false;
    /*
     * `iterate()` rather than `all()`, for `EventStore.read`'s reason one subject
     * over: `all()` materializes the whole prefix — up to the 1 MiB
     * `MAX_PLUGIN_DATA_BYTES` lets a plugin keep — to hand back the 128 KiB of it
     * that fit in one answer. Breaking out resets the statement; the next call is
     * unaffected.
     */
    const [from, upto] = range(prefix);
    for (const row of this.entriesStmt.iterate(pluginId, from, upto, upto, after)) {
      const key = String(row["key"]);
      const text = String(row["value"]);
      /*
       * ⚠ **Charged as the bytes the answer will carry, not as a row count.** The
       * page is bounded because it is sent over a channel that holds 256 KiB a
       * message while a plugin may keep 1 MiB, and a row count cannot see that:
       * 1000 keys is exactly `MAX_PLUGIN_KEYS` and says nothing about whether
       * they are four bytes each or four times the channel between them.
       *
       * `text` is the byte count of the value as it will be re-serialized, and
       * that is exact rather than an estimate: what is in the column was produced
       * by `JSON.stringify` in `PluginApi`, and `JSON.stringify(JSON.parse(t))`
       * is `t` byte for byte for such a string — same key order, no whitespace,
       * numbers round-tripping through the same double. A row edited by hand
       * could hold whitespace and would then be charged more than it costs, which
       * is the safe direction. The key is charged through `JSON.stringify` for the
       * opposite reason: a key may hold `"` or `\`, which are two bytes on the
       * wire and one here, and it is the only part of a pair that can grow.
       */
      const cost = SCAFFOLD_BYTES + Buffer.byteLength(JSON.stringify(key), "utf8") + Buffer.byteLength(text, "utf8");
      /*
       * Always at least one, or a single oversized row wedges a reader that can
       * never advance past it. Unreachable today — `MAX_PLUGIN_VALUE_BYTES` is
       * 64 KiB and every budget passed in is larger — but the two numbers are set
       * in two files, and this is the arm that decides which way that stops being
       * true.
       */
      if (entries.length > 0 && bytes + cost > maxBytes) {
        more = true;
        break;
      }
      bytes += cost;
      entries.push({ key, value: parseStored(text) });
    }
    return { entries, more };
  }

  dropPlugin(pluginId: string): void {
    this.dropStmt.run(pluginId);
    // Forgotten rather than zeroed, so the next write reseeds from the table.
    // Zeroing asserts the drop emptied it; forgetting asks. The difference is
    // only ever visible when a row outlives the drop — which `prune`'s orphan
    // sweep is there because it can, `host.ts` writing the row and the data as
    // two transactions with no BEGIN around them.
    this.usage.delete(pluginId);
  }

  /**
   * The running `(keys, bytes)` for one plugin, seeded from the table on first
   * touch and moved by every mutation after that.
   *
   * Returned by reference on purpose: the callers adjust the object they were
   * handed, so there is no second write-back to forget.
   */
  private usageOf(pluginId: string): { keys: number; bytes: number } {
    let held = this.usage.get(pluginId);
    if (held === undefined) {
      const row = this.usageStmt.get(pluginId);
      held = { keys: Number(row?.["n"] ?? 0), bytes: Number(row?.["bytes"] ?? 0) };
      this.usage.set(pluginId, held);
    }
    return held;
  }

  /** What one key's value costs on disk today, or `null` when there is no row. */
  private sizeOf(pluginId: string, key: string): number | null {
    const row = this.sizeStmt.get(pluginId, key);
    return row === undefined ? null : Number(row["bytes"] ?? 0);
  }
}

/**
 * The half-open range of keys a prefix names, as the index orders them.
 *
 * ⚠ **A range and not a `LIKE`, because `LIKE` folds case and this column does
 * not.** SQLite compares ASCII case-insensitively in `LIKE` unless told
 * otherwise, while `PRIMARY KEY (plugin_id, key)` collates BINARY — so the
 * pattern and the storage disagreed about what a prefix is. Measured against
 * this file's own DDL: `LIKE 'card:%'` answered `['CARD:3', 'Card:2', 'card:1']`
 * where the plugin had named one namespace and `card:1` was the only key in it.
 * Those are three rows a plugin can hold at once, so `keys` and `entries` were
 * handing back keys their caller had not asked for, and `PRAGMA
 * case_sensitive_like` was not the answer: it is a property of the connection,
 * and a later `LIKE` somewhere else would inherit it silently.
 *
 * `>=` and `<` are the comparison the index is already built on, so this seeks
 * rather than scans, and the escape discipline goes with the pattern — `%` and
 * `_` are ordinary characters to `<`.
 *
 * `null` above means unbounded: an empty prefix names every key this plugin has,
 * and there is no string to increment.
 */
function range(prefix: string): [string, string | null] {
  const points = [...prefix];
  // The successor of the prefix: the last code point raised by one. Anything
  // sorting below it and at or above the prefix is a key the prefix names.
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const at = points[i]?.codePointAt(0) ?? 0;
    // 0x10FFFF is the top of the range and cannot be raised; drop it and carry,
    // which is the same reason `zzz` carries to `{`.
    if (at >= 0x10ffff) continue;
    return [prefix, points.slice(0, i).join("") + String.fromCodePoint(successor(at))];
  }
  return [prefix, null];
}

/**
 * One code point on, in the values that survive the trip to the column.
 *
 * ⚠ **`at + 1` was the whole of this and it over-returned at exactly one code
 * point.** A JS string holds UTF-16 code units and this column holds UTF-8, and
 * the two do not agree about the surrogate block: `node:sqlite` binds a *lone*
 * surrogate as U+FFFD rather than as its own three bytes. So the successor of a
 * prefix ending U+D7FF — computed as U+D800, a lone high surrogate — reached
 * SQLite as U+FFFD, and the upper bound jumped over the whole of E000–FFFC
 * instead of stopping one code point along.
 *
 * Measured against this file's own DDL, `SELECT hex(?)`: U+D7FF binds `ED9FBF`,
 * U+E000 binds `EE8080`, and U+D800 binds `EFBFBD` — U+FFFD's bytes exactly.
 * With the five keys `\uD7FFa`, `\uD7FFb`, `\uE000private`, `\uF8FFapple`
 * and `\uFFFCobj` under one plugin id, `keys(id, "\uD7FF")` answered all five
 * where `startsWith` answers two. That is the same defect the LIKE-to-binary-range
 * rewrite above exists to close — a prefix handing back keys its caller did not
 * ask for — surviving at the one code point that borders the surrogates.
 *
 * The second arm is the prefix's own last code point being a lone surrogate,
 * which `[...prefix]` yields as a single element and which a plugin can send:
 * `"\ud800"` survives `JSON.parse` intact and nothing on the way here rejects
 * it. It is **mapped rather than skipped** — skipping it and carrying would
 * widen the bound to the next code point up, and the honest answer is narrower
 * than that: the bind already turned it into U+FFFD, so U+FFFD is what the
 * comparison is against and U+FFFE is what comes after it. Measured the same
 * way: writing the key `"\uD800zz"` and reading it back yields `"\uFFFDzz"`,
 * and with `at + 1` the two bounds both bound as `EFBFBD`, so an empty range
 * answered nothing at all for a key that is sitting right there.
 */
function successor(at: number): number {
  if (at >= 0xd800 && at <= 0xdfff) return 0xfffe;
  return at === 0xd7ff ? 0xe000 : at + 1;
}

/**
 * What a plugin kept, back the way it went in.
 *
 * Shared by `get` and `entries` so a value cannot be readable one way and not the
 * other. Written by this daemon as JSON, so the catch cannot be reached through
 * the API — and if the file has been edited by hand, `null` is a better answer
 * than a throw inside somebody's plugin.
 */
function parseStored(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What one `{"key":…,"value":…}` pair costs in the answer besides its own two strings.
 *
 * Counted rather than guessed: `{"key":` is 7, `,"value":` is 9, the closing
 * brace is 1 and the comma joining it to the next pair is 1 — 18, rounded up to
 * 20 for the two bytes of slack per pair.
 *
 * ⚠ **The rounding covers the pair and nothing else.** The array's own brackets
 * and the `{"t":"answer",…}` envelope are a fixed cost outside this number, and
 * on a one-pair page two bytes of slack does not pay for them — an earlier
 * version of this comment claimed it did, which contradicted `api.ts` one file
 * over. They are absorbed instead by the gap between the page budget and
 * `MAX_PLUGIN_MESSAGE_BYTES`, which is where a fixed cost belongs: it does not
 * scale with the page, so charging it per pair would be wrong in the other
 * direction on a large one.
 */
const SCAFFOLD_BYTES = 20;
