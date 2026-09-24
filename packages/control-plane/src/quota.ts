import type { DatabaseSync } from "node:sqlite";
import { MAX_MACHINES_PER_USER } from "./machines.js";
import { readInteger } from "./settings.js";

// Over the limit is derived, never stored: a machine is over iff its rank by (created_at, machine_id) among its owner's is >= the limit.
// Ordered by acquisition, never by last connection (that oscillates); evaluated only after a grant is proved, or it is an enumeration oracle.

interface QuotaStatements {
  standing: ReturnType<DatabaseSync["prepare"]>;
  count: ReturnType<DatabaseSync["prepare"]>;
  override: ReturnType<DatabaseSync["prepare"]>;
  tail: ReturnType<DatabaseSync["prepare"]>;
  fleet: ReturnType<DatabaseSync["prepare"]>;
  write: ReturnType<DatabaseSync["prepare"]>;
  clear: ReturnType<DatabaseSync["prepare"]>;
}

const quotaStatements = new WeakMap<DatabaseSync, QuotaStatements>();

function statements(db: DatabaseSync): QuotaStatements {
  let held = quotaStatements.get(db);
  if (held === undefined) {
    held = {
      // The relay's per-request question in one statement: rank, override and the owner's ban. The id tiebreak separates same-millisecond rows.
      standing: db.prepare(
        "SELECT o.user_id AS user_id, " +
          "  (SELECT COUNT(*) FROM machine_owners p " +
          "     WHERE p.user_id = o.user_id " +
          "       AND (p.created_at, p.machine_id) < (o.created_at, o.machine_id)) AS rank, " +
          "  (SELECT l.max_machines FROM user_machine_limits l WHERE l.user_id = o.user_id) AS override, " +
          "  (SELECT u.disabled_at FROM users u WHERE u.id = o.user_id) AS owner_disabled " +
          "FROM machine_owners o WHERE o.machine_id = ?",
      ),
      // No revoked filter: revoking deletes the ownership row.
      count: db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?"),
      override: db.prepare("SELECT max_machines FROM user_machine_limits WHERE user_id = ?"),
      // LIMIT -1 OFFSET is SQLite's "everything past n".
      tail: db.prepare(
        "SELECT machine_id, label FROM machine_owners WHERE user_id = ? " +
          "ORDER BY created_at ASC, machine_id ASC LIMIT -1 OFFSET ?",
      ),
      // Clamped to the ceiling as well, so this and machineStanding cannot disagree.
      fleet: db.prepare(
        "SELECT machine_id FROM (" +
          "  SELECT o.machine_id AS machine_id, " +
          "    MIN(COALESCE(l.max_machines, ?), ?) AS lim, " +
          "    (SELECT COUNT(*) FROM machine_owners p " +
          "       WHERE p.user_id = o.user_id " +
          "         AND (p.created_at, p.machine_id) < (o.created_at, o.machine_id)) AS rank " +
          "  FROM machine_owners o LEFT JOIN user_machine_limits l ON l.user_id = o.user_id" +
          ") WHERE rank >= lim",
      ),
      write: db.prepare(
        "INSERT INTO user_machine_limits (user_id, max_machines, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET max_machines = excluded.max_machines, " +
          "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      ),
      clear: db.prepare("DELETE FROM user_machine_limits WHERE user_id = ?"),
    };
    quotaStatements.set(db, held);
  }
  return held;
}

export type LimitSource = "user" | "default";

export interface EffectiveLimit {
  limit: number;
  source: LimitSource;
  /** What the limit would be with the per-user row cleared. */
  instanceDefault: number;
}

export interface Standing {
  ownerId: string;
  /** 0-based position among the owner's machines, oldest acquisition first. */
  rank: number;
  limit: number;
  source: LimitSource;
  over: boolean;
  /** The owner is banned. A separate gate from over with its own refusal code, and derived, so enabling the owner restores the fleet. */
  ownerDisabled: boolean;
}

/** Unset resolves to MAX_MACHINES_PER_USER, so an upgrade with no setting takes no machine off the network. */
export function instanceMachineLimit(db: DatabaseSync): number {
  return readInteger(db, "machines.per_user", MAX_MACHINES_PER_USER, 0, MAX_MACHINES_PER_USER);
}

export function effectiveLimit(db: DatabaseSync, userId: string): EffectiveLimit {
  const instanceDefault = instanceMachineLimit(db);
  const row = statements(db).override.get(userId);
  if (row === undefined) return { limit: instanceDefault, source: "default", instanceDefault };
  return {
    // Clamped on read too: a row written under a higher ceiling must not exceed this one.
    limit: Math.min(Number(row["max_machines"]), MAX_MACHINES_PER_USER),
    source: "user",
    instanceDefault,
  };
}

export function machineCount(db: DatabaseSync, userId: string): number {
  return Number(statements(db).count.get(userId)?.["n"] ?? 0);
}

/** null for a machine nobody owns, and callers must treat null as allowed. */
export function machineStanding(db: DatabaseSync, machineId: string): Standing | null {
  const row = statements(db).standing.get(machineId);
  if (row === undefined) return null;
  const override = row["override"];
  const limit =
    override === null || override === undefined
      ? instanceMachineLimit(db)
      : Math.min(Number(override), MAX_MACHINES_PER_USER);
  const rank = Number(row["rank"]);
  return {
    ownerId: String(row["user_id"]),
    rank,
    limit,
    source: override === null || override === undefined ? "default" : "user",
    over: rank >= limit,
    ownerDisabled: row["owner_disabled"] !== null && row["owner_disabled"] !== undefined,
  };
}

export function ownerDisabledMachineIds(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      "SELECT o.machine_id AS machine_id FROM machine_owners o " +
        "JOIN users u ON u.id = o.user_id WHERE u.disabled_at IS NOT NULL",
    )
    .all();
  return new Set(rows.map((row) => String(row["machine_id"])));
}

export interface OverLimitMachine {
  id: string;
  label: string;
}

/** The suspended tail, oldest first, so the last entry went first. Empty within the limit. */
export function overLimitMachines(db: DatabaseSync, userId: string, limit: number): OverLimitMachine[] {
  return statements(db)
    .tail.all(userId, Math.max(0, limit))
    .map((row) => ({ id: String(row["machine_id"]), label: String(row["label"]) }));
}

export function overLimitMachineIds(db: DatabaseSync): Set<string> {
  const rows = statements(db).fleet.all(instanceMachineLimit(db), MAX_MACHINES_PER_USER);
  return new Set(rows.map((row) => String(row["machine_id"])));
}

export function writeMachineLimit(
  db: DatabaseSync,
  userId: string,
  maxMachines: number,
  updatedBy: string | null,
  now = Date.now(),
): void {
  statements(db).write.run(userId, maxMachines, now, updatedBy);
}

export function clearMachineLimit(db: DatabaseSync, userId: string): boolean {
  return Number(statements(db).clear.run(userId).changes) === 1;
}
