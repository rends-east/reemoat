import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CP_SCHEMA_VERSION = 1;

const BUSY_TIMEOUT_MS = 250;

export interface OpenControlStoreOptions {
  path: string;
}

export interface ControlStore {
  db: DatabaseSync;
  close(): void;
}

export function openControlStore(options: OpenControlStoreOptions): ControlStore {
  const inMemory = options.path === ":memory:";
  if (!inMemory) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(options.path, { timeout: BUSY_TIMEOUT_MS });

  if (!inMemory) {
    // The directory too: SQLite writes -wal and -shm beside the file, and mkdirSync's mode covers only a directory it creates.
    try {
      chmodSync(dirname(options.path), 0o700);
    } catch {
      // A filesystem without POSIX modes is not a reason to refuse to start.
    }
    try {
      chmodSync(options.path, 0o600);
    } catch {
      // Same.
    }
  }

  applyPragmas(db, inMemory);
  applyControlPlaneSchema(db);

  return {
    db,
    close() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // On the way out; an un-checkpointed WAL is recovered on the next open.
      }
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// Prepared once per database: the relay's authorize runs these on every request, link on a link's. Weak so a closed database is not retained.
interface Statements {
  grant: ReturnType<DatabaseSync["prepare"]>;
  machine: ReturnType<DatabaseSync["prepare"]>;
  user: ReturnType<DatabaseSync["prepare"]>;
  link: ReturnType<DatabaseSync["prepare"]>;
}

const statementCache = new WeakMap<DatabaseSync, Statements>();

function statements(db: DatabaseSync): Statements {
  let held = statementCache.get(db);
  if (held === undefined) {
    held = {
      grant: db.prepare("SELECT scopes FROM grants WHERE user_id = ? AND machine_id = ?"),
      machine: db.prepare("SELECT id, name, enrolled_at, revoked_at FROM machines WHERE id = ?"),
      user: db.prepare("SELECT id, name, disabled_at FROM users WHERE id = ?"),
      link: db.prepare("SELECT source_machine_id, target_machine_id, revoked_at FROM machine_links WHERE id = ?"),
    };
    statementCache.set(db, held);
  }
  return held;
}

/** `null` is no grant and `[]` is a grant carrying nothing usable; both are refusals. */
export function grantFor(db: DatabaseSync, userId: string, machineId: string): string[] | null {
  const row = statements(db).grant.get(userId, machineId);
  if (!row) return null;
  return String(row["scopes"])
    .split(/\s+/)
    .filter((entry) => entry.length > 0);
}

export interface MachineRow {
  id: string;
  name: string;
  enrolled: boolean;
  revoked: boolean;
}

export function machineById(db: DatabaseSync, machineId: string): MachineRow | null {
  const row = statements(db).machine.get(machineId);
  if (!row) return null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    enrolled: row["enrolled_at"] !== null,
    revoked: row["revoked_at"] !== null,
  };
}

export interface LinkRow {
  sourceMachineId: string;
  targetMachineId: string;
  revoked: boolean;
}

/** Read live on every channel a link token opens, so revoking the row stops every token minted for it at once. */
export function linkById(db: DatabaseSync, linkId: string): LinkRow | null {
  const row = statements(db).link.get(linkId);
  if (!row) return null;
  return {
    sourceMachineId: String(row["source_machine_id"]),
    targetMachineId: String(row["target_machine_id"]),
    revoked: row["revoked_at"] !== null,
  };
}

/** A user that exists and is not disabled, or `null`. Read live on every relayed request. */
export function activeUser(db: DatabaseSync, userId: string): { id: string; name: string } | null {
  const row = statements(db).user.get(userId);
  if (!row || row["disabled_at"] !== null) return null;
  return { id: String(row["id"]), name: String(row["name"]) };
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
  // FULL, unlike the daemon's NORMAL: a lost write here could make a single-use enrollment code usable twice.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = OFF");
}

/** The only way to build the schema, drivers included: the file, then the version gate, then migrate, in that order. */
export function applyControlPlaneSchema(db: DatabaseSync): void {
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  checkSchemaVersion(db);
  migrate(db);
}

// Additions only, and CP_SCHEMA_VERSION does not move for them, so an older build still starts against this database.
function migrate(db: DatabaseSync): void {
  // One table_info reader per table (has asks machines only); SQL stays as plain literals because deploycheck reads them off this body.
  const columnsOf = (pragma: string): Set<string> =>
    new Set(db.prepare(pragma).all().map((column) => String(column["name"])));
  const machines = columnsOf("PRAGMA table_info(machines)");
  const users = columnsOf("PRAGMA table_info(users)");
  const apiKeys = columnsOf("PRAGMA table_info(api_keys)");
  const userSessions = columnsOf("PRAGMA table_info(user_sessions)");
  const has = (name: string): boolean => machines.has(name);

  addColumn(db, has("daemon_version"), "ALTER TABLE machines ADD COLUMN daemon_version TEXT");
  addColumn(db, has("daemon_protocol"), "ALTER TABLE machines ADD COLUMN daemon_protocol INTEGER");
  addColumn(db, has("daemon_seen_at"), "ALTER TABLE machines ADD COLUMN daemon_seen_at INTEGER");
  addColumn(db, has("daemon_agents"), "ALTER TABLE machines ADD COLUMN daemon_agents TEXT");
  // Who minted the redeemed enrollment code (a user or provisioning key id), not who redeemed it; NULL means unknown.
  addColumn(db, has("enrolled_by"), "ALTER TABLE machines ADD COLUMN enrolled_by TEXT");
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all();
  const hasDevice = (name: string): boolean => deviceColumns.some((column) => column["name"] === name);
  addColumn(db, hasDevice("public_key"), "ALTER TABLE devices ADD COLUMN public_key TEXT");
  addColumn(db, hasDevice("key_set_at"), "ALTER TABLE devices ADD COLUMN key_set_at INTEGER");
  addColumn(db, has("machine_key"), "ALTER TABLE machines ADD COLUMN machine_key TEXT");
  addColumn(db, has("machine_key_set_at"), "ALTER TABLE machines ADD COLUMN machine_key_set_at INTEGER");
  addColumn(db, users.has("password_changed_at"), "ALTER TABLE users ADD COLUMN password_changed_at INTEGER");
  addColumn(db, apiKeys.has("last_used_at"), "ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER");
  addColumn(db, userSessions.has("device_id"), "ALTER TABLE user_sessions ADD COLUMN device_id TEXT");
  // Here rather than in schema.sql: that file runs before this function, so an index on an added column fails on every existing database.
  db.exec("CREATE INDEX IF NOT EXISTS idx_user_sessions_device ON user_sessions (device_id)");
}

/** The API and the relay both run migrate on the same file at once, so losing the ADD COLUMN race is success; only that error is swallowed. */
function addColumn(db: DatabaseSync, present: boolean, statement: string): void {
  if (present) return;
  try {
    db.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name/i.test(message)) throw error;
  }
}

function checkSchemaVersion(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get();
  const found = Number(row?.["user_version"] ?? 0);
  if (found > CP_SCHEMA_VERSION) {
    throw new Error(
      `this file was written by a newer control plane (schema v${found}, this is v${CP_SCHEMA_VERSION}). ` +
        "Old code reading new columns mis-parses rather than fails, so it refuses instead.",
    );
  }
  if (found !== CP_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${CP_SCHEMA_VERSION}`);
}
