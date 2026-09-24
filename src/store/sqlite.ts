import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isBuiltinAgentId } from "../acp/agents.js";
import { MAX_TRACKED_ASYNC_TASKS, readKeptTask } from "../acp/asynctasks.js";
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
  keepsItsConversation,
  type MachineSettingKey,
  estimateBytes,
  isExitReason,
  isPersistedGiveUp,
  truncateEvent,
  type AgentHandle,
  type AgentStateMemory,
  type ExitReason,
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

// Stores are synchronous on purpose: a client attaches inside one uninterruptible block, which makes gap-free resume true. Nothing here may become async.

/** Bumping it makes an older daemon refuse the file; a nullable column an older daemon never selects needs no bump. */
export const SCHEMA_VERSION = 6;

const BUSY_TIMEOUT_MS = 250;

// Bounded: a lost attempt means a live competitor is rewriting the row, so refuse rather than spin.
const DAEMON_LOCK_ATTEMPTS = 3;

// One literal: the migration creates the index and SqliteMachineKeyStore recognises its violation by name.
const MACHINE_KEY_LIVE_INDEX = "machine_keys_one_live";

const SQLITE_CONSTRAINT_UNIQUE = 2067;

// Evict to a low-water mark below the bound, so a DELETE runs every few hundred appends rather than per append.
const EVICT_SLACK_EVENTS = 256;
const EVICT_SLACK_BYTES = 512 * 1024;
const EVICT_CHUNK = 512;
// Bounds the synchronous delete on the emit path; any remainder is evicted on the next append.
const EVICT_MAX_ROUNDS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETAIN_MS = 7 * DAY_MS;
// Caps inactive rows only; live rows are bounded by MAX_LIVE_SESSIONS in registry.ts (Q2.222).
const DEFAULT_MAX_SESSIONS = 200;
/** Floor under both prune sweeps, ranked active first, then pins, then most recently touched (Q2.222). */
export const DEFAULT_MIN_SESSIONS = 50;


export interface OpenStoresOptions {
  path: string;
  instanceId: string;
  maxEventsPerSession?: number | undefined;
  maxBytesPerSession?: number | undefined;
  maxEventBytes?: number | undefined;
  retainSessionsMs?: number | undefined;
  maxSessions?: number | undefined;
  minSessions?: number | undefined;
  onDegraded?: ((detail: string) => void) | undefined;
  /** What the startup prune removed, only when it removed something; not onDegraded, since a prune is not a failure. */
  onPruned?: ((detail: string) => void) | undefined;
}

export interface StoreBundle {
  db: DatabaseSync;
  events: SqliteEventStore;
  sessions: SqliteSessionStore;
  identity: SqliteIdentityStore;
  machineKeys: SqliteMachineKeyStore;
  credentials: SqliteAgentCredentialStore;
  systemCredentials: SqliteSystemCredentialStore;
  customAgents: SqliteCustomAgentStore;
  agentStrip: SqliteAgentStripStore;
  machineSettings: SqliteMachineSettingsStore;
  uploads: SqliteUploadStore;
  plugins: SqlitePluginRecordStore;
  pluginData: SqlitePluginDataStore;
  /** Ids the prune deleted: the caller removes their upload directories, which the prune runs too early to reach. */
  prunedSessions: string[];
  close(): void;
}

/** Fixes the startup order: the lock is claimed before migration, prune or restore. Throws on any failure; startup is strict. */
export function openStores(options: OpenStoresOptions): StoreBundle {
  const inMemory = options.path === ":memory:";
  if (!inMemory) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });

  if (!inMemory) {
    // As sensitive as REEMOAT_TOKEN. The directory is chmodded too: WAL and SHM files are created with the umask.
    try {
      chmodSync(dirname(options.path), 0o700);
    } catch {
      // Not a reason to refuse to start.
    }
    try {
      chmodSync(options.path, 0o600);
    } catch {
      // A filesystem without POSIX modes is not a reason to refuse to start.
    }
  }

  applyPragmas(db, inMemory);
  db.exec(loadSchema());
  // The lock comes before any permanent change, so a daemon about to be refused never upgrades the file.
  claimDaemonLock(db, options.instanceId, options.path);
  // Refuse a newer file before migrate can rewrite it.
  refuseNewerSchema(db);
  migrate(db);
  stampSchemaVersion(db);

  const sessions = new SqliteSessionStore(db, options.onDegraded, options.onPruned);
  const prunedSessions = sessions.prune({
    retainMs: options.retainSessionsMs ?? DEFAULT_RETAIN_MS,
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    minSessions: options.minSessions ?? DEFAULT_MIN_SESSIONS,
  });

  const events = new SqliteEventStore(db, {
    maxEventsPerSession: options.maxEventsPerSession,
    maxBytesPerSession: options.maxBytesPerSession,
    maxEventBytes: options.maxEventBytes,
    onDegraded: options.onDegraded,
  });
  events.seedFloors(sessions.list());

  const identity = new SqliteIdentityStore(db);
  const machineKeys = new SqliteMachineKeyStore(db);
  const credentials = new SqliteAgentCredentialStore(db);
  const systemCredentials = new SqliteSystemCredentialStore(db, options.onDegraded);
  const customAgents = new SqliteCustomAgentStore(db, options.onDegraded);
  const agentStrip = new SqliteAgentStripStore(db);
  const machineSettings = new SqliteMachineSettingsStore(db);
  const uploads = new SqliteUploadStore(db);
  const plugins = new SqlitePluginRecordStore(db, options.onDegraded);
  const pluginData = new SqlitePluginDataStore(db);

  return {
    db,
    events,
    sessions,
    identity,
    machineKeys,
    credentials,
    systemCredentials,
    customAgents,
    agentStrip,
    machineSettings,
    uploads,
    plugins,
    pluginData,
    prunedSessions,
    close() {
      try {
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

  // NORMAL: a process death loses nothing and a machine death cannot corrupt; FULL would fsync on the agent's emit path.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = OFF");
}

/** Decided from table_info rather than user_version, so it is idempotent. It may rewrite rows, and it is where this file prints, before any callback exists (Q4.29). */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  const hasSession = (name: string): boolean => columns.some((column) => column["name"] === name);
  if (!hasSession("owner_subject")) db.exec("ALTER TABLE sessions ADD COLUMN owner_subject TEXT");

  if (!hasSession("container_id")) db.exec("ALTER TABLE sessions ADD COLUMN container_id TEXT");
  if (!hasSession("agent_pgid")) db.exec("ALTER TABLE sessions ADD COLUMN agent_pgid INTEGER");
  if (!hasSession("container_started_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN container_started_at INTEGER");
  }

  if (!hasSession("resume_gave_up")) db.exec("ALTER TABLE sessions ADD COLUMN resume_gave_up TEXT");

  if (!hasSession("title")) db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
  if (!hasSession("pinned")) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasSession("ultracode")) db.exec("ALTER TABLE sessions ADD COLUMN ultracode INTEGER");

  if (!hasSession("rank")) db.exec("ALTER TABLE sessions ADD COLUMN rank REAL");

  if (!hasSession("custom_agent")) db.exec("ALTER TABLE sessions ADD COLUMN custom_agent TEXT");

  if (!hasSession("agent_state_json")) db.exec("ALTER TABLE sessions ADD COLUMN agent_state_json TEXT");


  const identityColumns = db.prepare("PRAGMA table_info(identity)").all();
  const has = (name: string): boolean => identityColumns.some((column) => column["name"] === name);
  if (!has("tunnel_key")) db.exec("ALTER TABLE identity ADD COLUMN tunnel_key TEXT");
  if (!has("relay_url")) db.exec("ALTER TABLE identity ADD COLUMN relay_url TEXT");

  migrateCredentialsToV6(db);
  migrateMachineKeysToOneLive(db);
}

/** v6: agent credentials are rekeyed to (agent, env_name), newest wins; forge_accounts is dropped since its tokens are unrevocable. */
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

  const forgeRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='forge_accounts'").all();
  if (forgeRows.length > 0) {
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM forge_accounts").get()?.["n"] ?? 0);
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
 * Keeps the oldest live machine key and retires the rest, then creates the index, which cannot exist over two live rows.
 * The pick is only a starting point: a 409 at the dial promotes another retired key.
 */
function migrateMachineKeysToOneLive(db: DatabaseSync): void {
  const [kept, ...losers] = db
    .prepare("SELECT kth FROM machine_keys WHERE retired_at IS NULL ORDER BY created_at ASC, kth ASC")
    .all()
    .map((row) => String(row["kth"]));
  if (kept !== undefined && losers.length > 0) {
    const retire = db.prepare("UPDATE machine_keys SET retired_at = ? WHERE kth = ? AND retired_at IS NULL");
    const at = Date.now();
    for (const kth of losers) retire.run(at, kth);
    console.error(
      `Reemoat: this database held ${losers.length + 1} live machine keys, which only two daemons ` +
        `racing on one file could produce. Kept the oldest (${kept}); retired ${losers.join(", ")}. ` +
        "Which one the control plane pinned is not knowable from here and is not guessed: if the " +
        "dial is refused 409, this daemon promotes a retired key and dials again, once per key. " +
        "`cpctl admin clearkey <machineId>` is still the way back if every one of them is refused.",
    );
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${MACHINE_KEY_LIVE_INDEX} ` +
      "ON machine_keys (retired_at IS NULL) WHERE retired_at IS NULL",
  );
}

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

export interface DaemonRow {
  instanceId: string;
  pid: number;
  startedAt: number;
}

/** Compare-and-set on the daemon row: take it only if it still holds exactly what was observed. IS rather than = keeps the comparison total over NULL. */
export function takeDaemonRow(db: DatabaseSync, claimant: DaemonRow, observed: DaemonRow | null): boolean {
  const result = db
    .prepare(
      "INSERT INTO daemon (id, instance_id, pid, started_at) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, " +
        "pid = excluded.pid, started_at = excluded.started_at " +
        "WHERE daemon.instance_id IS ? AND daemon.pid IS ? AND daemon.started_at IS ?",
    )
    .run(
      claimant.instanceId,
      claimant.pid,
      claimant.startedAt,
      observed?.instanceId ?? null,
      observed?.pid ?? null,
      observed?.startedAt ?? null,
    );
  return Number(result.changes) > 0;
}

function claimDaemonLock(db: DatabaseSync, instanceId: string, path: string): void {
  for (let attempt = 0; attempt < DAEMON_LOCK_ATTEMPTS; attempt += 1) {
    const row = db.prepare("SELECT instance_id, pid, started_at FROM daemon WHERE id = 1").get();
    let observed: DaemonRow | null = null;
    if (row) {
      const pid = Number(row["pid"]);
      const startedAt = Number(row["started_at"]);
      if (pid !== process.pid && startedAt >= bootTime() && isAlive(pid)) {
        throw new Error(
          `another Reemoat daemon (pid ${pid}, instance ${String(row["instance_id"])}) owns ${path}.\n` +
            "  Stop it, or point this one somewhere else with REEMOAT_DB.",
        );
      }
      observed = { instanceId: String(row["instance_id"]), pid, startedAt };
    }
    if (takeDaemonRow(db, { instanceId, pid: process.pid, startedAt: Date.now() }, observed)) return;
  }
  throw new Error(
    `could not claim ${path}: another process rewrote the daemon row under every one of ` +
      `${DAEMON_LOCK_ATTEMPTS} attempts.\n` +
      "  Something else is starting against this file right now. Stop it, or point this one " +
      "somewhere else with REEMOAT_DB.",
  );
}

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
    // seq below the newest never deletes the newest row, which keeps lastSeq derivable at load.
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

  /** Counters are derived at load, not persisted: that needs dense seqs, prefix eviction and the newest row kept. */
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

  /** A floor, never a ceiling: without it a pruned session restarts at seq 1 and a resuming client sees reused numbers. */
  seedFloors(rows: readonly PersistedSession[]): void {
    for (const row of rows) {
      const counters = this.countersFor(row.id);
      if (row.lastSeq > counters.lastSeq) counters.lastSeq = row.lastSeq;
      if (row.dropped > counters.dropped) counters.dropped = row.dropped;
    }
  }

  append(sessionId: string, event: SessionEvent): StoredEvent {
    const counters = this.countersFor(sessionId);
    // Burned and never reused: two clients must never see different events under one seq.
    const seq = counters.lastSeq + 1;
    counters.lastSeq = seq;
    const ts = Date.now();

    // Serialization can throw where truncation did not (a cyclic rawInput), so all three share one try.
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

    // A placeholder at the same seq, returned instead of the real event: a visible loss beats a silent hole or clients that disagree.
    const note: SessionEvent = {
      type: "error",
      message: `seq ${seq} (${payload.type}) could not be persisted: ${this.lastError}`,
      data: null,
    };
    const noteBytes = estimateBytes(note);
    if (this.insert(sessionId, seq, ts, noteBytes, JSON.stringify(note))) {
      this.credit(counters, seq, noteBytes);
    }
    return { seq, ts, event: note };
  }

  read(sessionId: string, since: number, limit: number, maxBytes: number): StoredEvent[] {
    const out: StoredEvent[] = [];
    if (limit <= 0) return out;
    let bytes = 0;
    try {
      // seq above the cursor guarantees attach advances; iterate so a page never materializes more than it returns.
      for (const row of this.readStmt.iterate(sessionId, since, limit)) {
        const rowBytes = Number(row["bytes"] ?? 0);
        // Always yield at least one, or an oversized record wedges the reader.
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
    // Dropped regardless: leftover rows are swept as orphans at the next startup.
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
      this.insertStmt.run(sessionId, seq, ts, bytes, json);
      return true;
    } catch (error) {
      // No retry: busy_timeout covers the retryable case, and a full disk fails the same way twice.
      this.lastError = describeError(error);
      this.markDegraded(this.lastError);
      return false;
    }
  }

  private evict(sessionId: string, counters: Counters): void {
    if (counters.count <= this.maxEvents && counters.bytes <= this.maxBytes) return;

    // Slack is clamped to a fraction of the window, so a tiny REEMOAT_LOG_EVENTS is not wiped.
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

    // Queried rather than computed: a failed insert can leave a hole.
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
      // A caller-supplied callback; its failure is not ours to propagate.
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
    // A corrupt row stays in the sequence rather than punching a hole in it.
    event = { type: "error", message: `seq ${seq} could not be decoded: ${describeError(error)}`, data: null };
  }
  return { seq, ts, event };
}

export interface PruneOptions {
  /** How long an *inactive* session may go untouched before the age sweep may take it. */
  retainMs: number;
  maxSessions: number;
  minSessions: number;
}

export class SqliteSessionStore implements SessionStore {
  private readonly putStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly removeSessionStmt: StatementSync;
  private readonly removeEventsStmt: StatementSync;
  private readonly lastWritten = new Map<string, string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly onDegraded: ((detail: string) => void) | undefined = undefined,
    private readonly onPruned: ((detail: string) => void) | undefined = undefined,
  ) {
    this.putStmt = db.prepare(
      `INSERT INTO sessions (
         id, agent, created_at, updated_at, agent_session_id, agent_pid, status, exit_json,
         container_id, agent_pgid, container_started_at,
         turn_counter, last_event_at, perm_seq, perm_salt, resume_gave_up, last_seq, dropped, title, pinned, rank,
         ultracode, custom_agent, agent_state_json,
         workspace_json, workspace_mode, workspace_root, workspace_branch, workspace_base
       ) VALUES (
         :id, :agent, :created_at, :updated_at, :agent_session_id, :agent_pid, :status, :exit_json,
         :container_id, :agent_pgid, :container_started_at,
         :turn_counter, :last_event_at, :perm_seq, :perm_salt, :resume_gave_up, :last_seq, :dropped, :title, :pinned, :rank,
         :ultracode, :custom_agent, :agent_state_json,
         :workspace_json, :workspace_mode, :workspace_root, :workspace_branch, :workspace_base
       )
       ON CONFLICT(id) DO UPDATE SET
         updated_at       = excluded.updated_at,
         title            = excluded.title,
         pinned           = excluded.pinned,
         rank             = excluded.rank,
         ultracode        = excluded.ultracode,
         agent_state_json = excluded.agent_state_json,
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
      const key = JSON.stringify(params);
      if (this.lastWritten.get(row.id) === key) return;
      this.putStmt.run({ ...params, updated_at: Date.now() });
      this.lastWritten.set(row.id, key);
    } catch {
      // Swallowed: a bookkeeping fault on the state-change path must not unwind a turn; the next touch recovers it.
    }
  }

  list(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const row of this.listStmt.all()) {
      const parsed = fromRow(row);
      // Skip rather than throw: one unparsable row must not lose every row after it.
      if (parsed) {
        out.push(parsed);
        continue;
      }
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
   * Deletes only inactive rows, idle past retainMs or ranked past the cap, never below minSessions, and reports it through onPruned (Q2.222).
   * Returns the removed ids so the caller can sweep their upload directories.
   */
  prune(options: PruneOptions): string[] {
    const cutoff = Date.now() - options.retainMs;
    const stale: string[] = [];
    const excess: string[] = [];
    this.db.exec("BEGIN");
    try {
      // Classified in TypeScript off the raw table, so rows fromRow drops still count toward the floor and cap.
      const rows = this.db
        .prepare("SELECT id, pinned, exit_json, resume_gave_up, updated_at, created_at FROM sessions ORDER BY id")
        .all();
      const inactive = rows
        .filter((row) => !isActiveRow(row))
        .sort(
          (a, b) =>
            Number(b["pinned"]) - Number(a["pinned"]) ||
            Number(b["updated_at"]) - Number(a["updated_at"]) ||
            Number(b["created_at"]) - Number(a["created_at"]) ||
            (String(a["id"]) < String(b["id"]) ? -1 : String(a["id"]) > String(b["id"]) ? 1 : 0),
        );
      const active = rows.length - inactive.length;
      inactive.forEach((row, index) => {
        // Rule 2: a row ranked within the floor, active rows first, is kept by both sweeps.
        const rank = index + 1;
        if (active + rank <= options.minSessions) return;
        const id = String(row["id"]);
        // Rule 1 before rule 3: a row both idle and over the cap counts as idle.
        if (!Number(row["pinned"]) && Number(row["updated_at"]) < cutoff) stale.push(id);
        else if (rank > options.maxSessions) excess.push(id);
      });

      for (const id of [...stale, ...excess]) {
        this.removeEventsStmt.run(id);
        this.removeSessionStmt.run(id);
        this.lastWritten.delete(id);
      }
      this.db.exec("DELETE FROM events WHERE session_id NOT IN (SELECT id FROM sessions)");
      this.db.exec("DELETE FROM uploads WHERE session_id NOT IN (SELECT id FROM sessions)");
      // Plugin data with no plugin row: host.ts removes the two separately, and strays would pass to the next install of that id.
      this.db.exec("DELETE FROM plugin_data WHERE plugin_id NOT IN (SELECT id FROM plugins)");
      // Pasted credentials are deliberately never swept; only their routes remove them (Q7.124).
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back — the BEGIN itself failed.
      }
      return [];
    }
    const removed = [...stale, ...excess];
    // Reported after the COMMIT and outside the try, so a throwing sink cannot roll back or empty the returned list.
    if (removed.length > 0) {
      const parts: string[] = [];
      if (stale.length > 0) {
        parts.push(`${stale.length} idle past ${describeRetain(options.retainMs)} (${stale.join(", ")})`);
      }
      if (excess.length > 0) {
        parts.push(`${excess.length} over the ${options.maxSessions}-session cap (${excess.join(", ")})`);
      }
      try {
        this.onPruned?.(
          `pruned ${removed.length} session(s) with their transcripts: ${parts.join("; ")}. ` +
            "A live session, or one the daemon is still coming back to, is never pruned, a pin goes only after every other inactive row, " +
            `and at least ${options.minSessions} rows stay at any age — active first, then pins, then the most recently touched; ` +
            "the cap is across the whole file, not per person.",
        );
      } catch {
      }
    }
    this.reclaim();
    return removed;
  }

  /**
   * VACUUM once a quarter of the file is free, since auto_vacuum cannot be enabled on an existing file.
   * Only here: after the lock, before any listener, outside the transaction.
   */
  private reclaim(): void {
    try {
      const free = Number(this.db.prepare("PRAGMA freelist_count").get()?.["freelist_count"] ?? 0);
      const total = Number(this.db.prepare("PRAGMA page_count").get()?.["page_count"] ?? 0);
      if (total === 0 || free / total < 0.25) return;
      this.db.exec("VACUUM");
    } catch {
      // Best effort: a large database is the status quo, a daemon that will not start is not.
    }
  }
}

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
      // consumed_at is bound, not NULL: an image the agent returned is inserted already consumed.
      "INSERT INTO uploads (session_id, upload_id, name, orig_name, mime, bytes, created_at, consumed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.getStmt = db.prepare("SELECT * FROM uploads WHERE session_id = ? AND upload_id = ?");
    this.sumStmt = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM uploads WHERE session_id = ?");
    this.countStmt = db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE session_id = ?");
    this.consumeStmt = db.prepare(
      "UPDATE uploads SET consumed_at = ? WHERE session_id = ? AND upload_id = ? AND consumed_at IS NULL",
    );
    this.listForStmt = db.prepare("SELECT * FROM uploads WHERE session_id = ? ORDER BY created_at");
    this.sessionsStmt = db.prepare("SELECT DISTINCT session_id FROM uploads");
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
    // 1/0 here rather than at the statement: the dirty-check key is JSON of this object.
    pinned: row.pinned ? 1 : 0,
    rank: row.rank,
    ultracode: row.ultracode === null ? null : row.ultracode ? 1 : 0,
    // Never in the DO UPDATE, like agent: what a session was started as is immutable.
    custom_agent: row.customAgent,
    agent_state_json: row.agentState === null ? null : JSON.stringify(row.agentState),
    workspace_json: JSON.stringify(row.workspace),
    workspace_mode: row.workspace.mode,
    workspace_root: row.workspace.root,
    workspace_branch: row.workspace.git?.branch ?? null,
    workspace_base: row.workspace.git?.baseCommit ?? null,
  };
}

/** container_id is the discriminator; a partial container handle is no handle at all. */
function toHandle(row: Record<string, unknown>): AgentHandle | null {
  const containerId = row["container_id"];
  if (containerId != null) {
    // Legacy and read-only, validated anyway: the file is hand-editable. A pgid of 0 or 1 is refused.
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

function readExitReason(exitJson: unknown): ExitReason | null {
  if (typeof exitJson !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(exitJson);
    if (parsed === null || typeof parsed !== "object") return null;
    const reason = (parsed as { reason?: unknown }).reason;
    return isExitReason(reason) ? reason : null;
  } catch {
    // Not JSON. A row this daemon cannot read is a row it may not delete.
    return null;
  }
}

/** A live row is active; then an honoured resume_gave_up makes it inactive; then keepsItsConversation or an unreadable exit keeps it (Q2.222). */
function isActiveRow(row: Record<string, unknown>): boolean {
  const exitJson = row["exit_json"];
  if (exitJson === null || exitJson === undefined) return true;
  if (isPersistedGiveUp(row["resume_gave_up"])) return false;
  const reason = readExitReason(exitJson);
  return reason === null || keepsItsConversation({ reason });
}

function describeRetain(ms: number): string {
  const days = ms / DAY_MS;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} day(s)`;
}

/** Converts a pre-v4 agentPid into agentHandle, since the column migration cannot reach inside the JSON blob. */
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

/** Its own try: an unreadable blob costs the remembered strip, never the session. */
function toAgentState(value: unknown): AgentStateMemory | null {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { config, commands, tasks } = parsed as { config?: unknown; commands?: unknown; tasks?: unknown };
    if (typeof config !== "object" || config === null) return null;
    if (typeof commands !== "object" || commands === null) return null;
    const { options, modes } = config as { options?: unknown; modes?: unknown };
    const { commands: list, dropped } = commands as { commands?: unknown; dropped?: unknown };
    if (!Array.isArray(options) || !Array.isArray(list)) return null;
    if (!isAgentModes(modes)) return null;
    if (!options.every(isAgentConfigOption)) return null;
    if (!list.every(isAgentCommand)) return null;
    const cut = Number(dropped ?? 0);
    // Row by row, unlike the controls: a finished task this build cannot read costs that row alone.
    const kept = (Array.isArray(tasks) ? tasks.map(readKeptTask) : [])
      .filter((task) => task !== null)
      .slice(0, MAX_TRACKED_ASYNC_TASKS);
    return {
      config: {
        modes: modes ?? null,
        options: options as AgentStateMemory["config"]["options"],
      },
      commands: {
        commands: list as AgentStateMemory["commands"]["commands"],
        dropped: Number.isFinite(cut) ? cut : 0,
      },
      ...(kept.length > 0 ? { tasks: kept } : {}),
    };
  } catch {
    // Unreadable JSON. See the docblock: a faint strip, never a lost session.
    return null;
  }
}

/** Absent reads as null, so an optional modes field cannot discard the whole memory. */
function isAgentModes(value: unknown): value is AgentStateMemory["config"]["modes"] {
  if (value == null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const { current, available } = value as { current?: unknown; available?: unknown };
  if (typeof current !== "string") return false;
  if (!Array.isArray(available)) return false;
  return available.every((mode) => {
    if (typeof mode !== "object" || mode === null) return false;
    const { id, name } = mode as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string";
  });
}

function isAgentConfigOption(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { id, kind, value: current, choices } = value as Record<string, unknown>;
  if (typeof id !== "string") return false;
  if (kind !== "select" && kind !== "boolean") return false;
  if (typeof current !== "string" && typeof current !== "boolean") return false;
  if (!Array.isArray(choices)) return false;
  return choices.every((choice) => {
    if (typeof choice !== "object" || choice === null) return false;
    const { value: choiceValue, name } = choice as { value?: unknown; name?: unknown };
    return typeof choiceValue === "string" && typeof name === "string";
  });
}

/** One command. `name` is what the `/` menu matches on and what is sent. */
function isAgentCommand(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { name?: unknown }).name === "string";
}

function fromRow(row: Record<string, unknown>): PersistedSession | null {
  try {
    const workspace = JSON.parse(String(row["workspace_json"])) as SessionWorkspace;
    if (typeof workspace?.root !== "string") return null;
    // Validated, not cast: an unknown built-in id drops the row; a contributed id passes by shape (Q7.31).
    const agent = String(row["agent"]);
    if (!isBuiltinAgentId(agent) && !isContributedId(agent)) return null;
    const exitJson = row["exit_json"];
    return {
      id: String(row["id"]),
      agent,
      createdAt: Number(row["created_at"] ?? 0),
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
      title: row["title"] == null ? null : String(row["title"]),
      pinned: Number(row["pinned"] ?? 0) !== 0,
      // Read by shape: coercing NULL gives 0, which is a real position, the oldest.
      rank: typeof row["rank"] === "number" && Number.isFinite(row["rank"]) ? row["rank"] : null,
      ultracode: row["ultracode"] == null ? null : Number(row["ultracode"]) !== 0,
      customAgent: row["custom_agent"] == null ? null : String(row["custom_agent"]),
      agentState: toAgentState(row["agent_state_json"]),
    };
  } catch {
    return null;
  }
}

export interface AgentCredential {
  agent: string;
  envName: string;
  updatedAt: number;
}

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

/** Has a getter, unlike agent credentials: a system key becomes a providers/set header value. Routes get only list. */
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
    return this.listStmt.all().flatMap((row) => {
      const system = String(row["system"]);
      if (isBuiltinSystemId(system) || isContributedId(system)) {
        return [{ system, updatedAt: Number(row["updated_at"] ?? 0) }];
      }
      // Reported, since nothing else ages this plaintext key out (Q7.124).
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
    // An upsert for PATCH; created_at is deliberately never updated.
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

/** Shape, not membership: this runs at every restore, so a plugin missing at boot must not un-assemble presets (Q7.31). */
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

/** A partial order over agents it does not own: ref is deliberately not validated. */
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

  list(): AgentStripEntry[] {
    return this.listStmt.all().flatMap((row) => {
      const kind = String(row["kind"]);
      if (kind !== "harness" && kind !== "custom") return [];
      return [{ kind, ref: String(row["ref"]), hidden: Number(row["hidden"] ?? 0) !== 0 }];
    });
  }

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
        // Nothing to roll back: the BEGIN itself failed.
      }
      throw error;
    }
  }

  forget(kind: AgentStripEntry["kind"], ref: string): void {
    this.forgetStmt.run(kind, ref);
  }
}


/** Person-owned machine settings, not config; a key this build cannot name is never read (Q2.225). */
export class SqliteMachineSettingsStore {
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT value FROM machine_settings WHERE key = ?");
    this.setStmt = db.prepare(
      "INSERT INTO machine_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
  }

  /** The stored value, or `null` where nobody has set one. */
  read(key: MachineSettingKey): string | null {
    const row = this.getStmt.get(key);
    return row === undefined ? null : String(row["value"]);
  }

  write(key: MachineSettingKey, value: string): void {
    this.setStmt.run(key, value);
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
  tunnelKey: string | null;
  /** Where to dial for a tunnel, or `null` for a control plane running no relay. */
  relayUrl: string | null;
}

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

export interface StoredMachineKey {
  kth: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  retiredAt: number | null;
}

/** At most one live row, enforced by MACHINE_KEY_LIVE_INDEX. Methods throw, except save absorbing the live-index conflict. */
export class SqliteMachineKeyStore {
  private readonly activeStmt: StatementSync;
  private readonly allStmt: StatementSync;
  private readonly saveStmt: StatementSync;
  private readonly retireStmt: StatementSync;
  private readonly retireOthersStmt: StatementSync;
  private readonly reviveStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.activeStmt = db.prepare(
      "SELECT kth, public_key, private_key, created_at, retired_at FROM machine_keys " +
        "WHERE retired_at IS NULL ORDER BY created_at DESC, kth ASC LIMIT 1",
    );
    this.allStmt = db.prepare(
      "SELECT kth, public_key, private_key, created_at, retired_at FROM machine_keys " +
        "ORDER BY created_at ASC, kth ASC",
    );
    this.saveStmt = db.prepare(
      "INSERT INTO machine_keys (kth, public_key, private_key, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(kth) DO NOTHING",
    );
    this.retireStmt = db.prepare("UPDATE machine_keys SET retired_at = ? WHERE kth = ? AND retired_at IS NULL");
    this.retireOthersStmt = db.prepare(
      "UPDATE machine_keys SET retired_at = ? WHERE retired_at IS NULL AND kth <> ?",
    );
    this.reviveStmt = db.prepare("UPDATE machine_keys SET retired_at = NULL WHERE kth = ?");
  }

  /** The key this machine answers on now, or `null` before one is generated. */
  active(): StoredMachineKey | null {
    const row = this.activeStmt.get();
    if (!row) return null;
    return rowToMachineKey(row);
  }

  all(): StoredMachineKey[] {
    return this.allStmt.all().map(rowToMachineKey);
  }

  /**
   * Retire the others, then revive: the reverse violates the live-row index mid-statement.
   * Rolls back when kth names no row, or nothing would be live.
   */
  promote(kth: string, now = Date.now()): boolean {
    this.db.exec("BEGIN");
    try {
      this.retireOthersStmt.run(now, kth);
      const promoted = Number(this.reviveStmt.run(kth).changes) > 0;
      this.db.exec(promoted ? "COMMIT" : "ROLLBACK");
      return promoted;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back: the BEGIN itself failed.
      }
      throw error;
    }
  }

  /** DO NOTHING: kth hashes the public half. A racing second live row is refused by the index and absorbed. */
  save(key: Omit<StoredMachineKey, "retiredAt">): void {
    try {
      this.saveStmt.run(key.kth, key.publicKey, key.privateKey, key.createdAt);
    } catch (error) {
      // Swallowed only for the live-row conflict: the winner's key is already there for the read-back.
      if (!isLiveMachineKeyConflict(error)) throw error;
    }
  }

  retire(kth: string, now = Date.now()): void {
    this.retireStmt.run(now, kth);
  }
}

function rowToMachineKey(row: Record<string, unknown>): StoredMachineKey {
  return {
    kth: String(row["kth"]),
    publicKey: String(row["public_key"]),
    privateKey: String(row["private_key"]),
    createdAt: Number(row["created_at"] ?? 0),
    retiredAt: row["retired_at"] == null ? null : Number(row["retired_at"]),
  };
}

/** Matches errcode and index name both, so a future unique constraint still throws. */
function isLiveMachineKeyConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return Number(errcode) === SQLITE_CONSTRAINT_UNIQUE && error.message.includes(MACHINE_KEY_LIVE_INDEX);
}


/** Wall-clock time of the last boot. Pids from before it may have been recycled. */
function bootTime(): number {
  return Date.now() - uptime() * 1000;
}

/** EPERM counts as dead here: the row was written by our own daemon, so a pid we cannot signal was recycled. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM"
      ? true
      : false;
  }
}

/** The manifest is re-validated on every read; an unreadable row is reported and skipped. */
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
    this.hasStmt = db.prepare("SELECT 1 FROM plugins WHERE id = ?");
    this.putStmt = db.prepare(
      "INSERT INTO plugins (id, version, manifest_json, enabled, installed_at, updated_at, source) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json, " +
        "enabled = excluded.enabled, updated_at = excluded.updated_at, source = excluded.source",
    );
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
    // presenting false: a refusal added later must not retroactively drop an installed plugin.
    const parsed = parseManifest(String(row["manifest_json"] ?? ""), { presenting: false });
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

export class SqlitePluginDataStore implements PluginDataStore {
  private readonly getStmt: StatementSync;
  private readonly sizeStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly keysStmt: StatementSync;
  private readonly entriesStmt: StatementSync;
  private readonly dropStmt: StatementSync;
  private readonly usageStmt: StatementSync;
  // Running (keys, bytes) per plugin: recomputing per write made filling a store quadratic.
  private readonly usage = new Map<string, { keys: number; bytes: number }>();

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT value FROM plugin_data WHERE plugin_id = ? AND key = ?");
    this.sizeStmt = db.prepare(
      "SELECT LENGTH(CAST(value AS BLOB)) AS bytes FROM plugin_data WHERE plugin_id = ? AND key = ?",
    );
    this.setStmt = db.prepare(
      "INSERT INTO plugin_data (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    // RETURNING is safe because the WHERE names the whole primary key; widening it would break the single step.
    this.deleteStmt = db.prepare(
      "DELETE FROM plugin_data WHERE plugin_id = ? AND key = ? " +
        "RETURNING LENGTH(CAST(value AS BLOB)) AS bytes",
    );
    // A binary range, not LIKE: LIKE folds ASCII case while the key collates BINARY.
    this.keysStmt = db.prepare(
      "SELECT key FROM plugin_data WHERE plugin_id = ? AND key >= ? AND (? IS NULL OR key < ?) ORDER BY key",
    );
    this.entriesStmt = db.prepare(
      "SELECT key, value FROM plugin_data WHERE plugin_id = ? AND key >= ? AND (? IS NULL OR key < ?) AND key > ? ORDER BY key",
    );
    this.dropStmt = db.prepare("DELETE FROM plugin_data WHERE plugin_id = ?");
    this.usageStmt = db.prepare(
      // CAST AS BLOB: LENGTH on TEXT counts characters, and the quota is in bytes.
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
    checkPluginWrite(key, value, { keys: usage.keys, bytes: usage.bytes, existing });
    this.setStmt.run(pluginId, key, value, Date.now());
    usage.bytes += Buffer.byteLength(value, "utf8") - (existing ?? 0);
    if (existing === null) usage.keys += 1;
  }

  delete(pluginId: string, key: string): void {
    // Seed before deleting, or a first-touch delete subtracts the row twice and widens the quota.
    const usage = this.usageOf(pluginId);
    const row = this.deleteStmt.get(pluginId, key);
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
    const [from, upto] = range(prefix);
    for (const row of this.entriesStmt.iterate(pluginId, from, upto, upto, after)) {
      const key = String(row["key"]);
      const text = String(row["value"]);
      // Charged in answer bytes, not rows: the channel caps a message below what a plugin may store.
      const cost = SCAFFOLD_BYTES + Buffer.byteLength(JSON.stringify(key), "utf8") + Buffer.byteLength(text, "utf8");
      // Always at least one, or an oversized row wedges the reader.
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
    this.usage.delete(pluginId);
  }

  private usageOf(pluginId: string): { keys: number; bytes: number } {
    let held = this.usage.get(pluginId);
    if (held === undefined) {
      const row = this.usageStmt.get(pluginId);
      held = { keys: Number(row?.["n"] ?? 0), bytes: Number(row?.["bytes"] ?? 0) };
      this.usage.set(pluginId, held);
    }
    return held;
  }

  private sizeOf(pluginId: string, key: string): number | null {
    const row = this.sizeStmt.get(pluginId, key);
    return row === undefined ? null : Number(row["bytes"] ?? 0);
  }
}

function range(prefix: string): [string, string | null] {
  const points = [...prefix];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const at = points[i]?.codePointAt(0) ?? 0;
    if (at >= 0x10ffff) continue;
    return [prefix, points.slice(0, i).join("") + String.fromCodePoint(successor(at))];
  }
  return [prefix, null];
}

/** node:sqlite binds a lone surrogate as U+FFFD, so D7FF steps to E000 and a surrogate maps to FFFE. */
function successor(at: number): number {
  if (at >= 0xd800 && at <= 0xdfff) return 0xfffe;
  return at === 0xd7ff ? 0xe000 : at + 1;
}

function parseStored(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Per-pair JSON overhead beside the two strings, rounded up; the envelope fits the page budget's headroom. */
const SCAFFOLD_BYTES = 20;
