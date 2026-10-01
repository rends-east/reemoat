import type { DatabaseSync } from "node:sqlite";

// Whether agents may message each other: an account row over a machine row, no row meaning on (Q2.244).
// The stamp is what a daemon orders pushed copies by, so every write takes one above all earlier ones (Q1.654).

export interface MessagingPolicy {
  on: boolean;
  /** 0 when neither row exists. */
  at: number;
}

/** A machine's own row: isolated is kept while it is off, and means something only while it is on (Q2.244). */
export interface MachinePermission extends MessagingPolicy {
  isolated: boolean;
}

/** What a machine's daemon enforces: its owner's account row and its own, with its own isolation. */
export interface MachinePolicy extends MessagingPolicy {
  isolated: boolean;
}

interface PermissionStatements {
  account: ReturnType<DatabaseSync["prepare"]>;
  machine: ReturnType<DatabaseSync["prepare"]>;
  clock: ReturnType<DatabaseSync["prepare"]>;
  writeAccount: ReturnType<DatabaseSync["prepare"]>;
  writeMachine: ReturnType<DatabaseSync["prepare"]>;
  offMachines: ReturnType<DatabaseSync["prepare"]>;
  isolatedMachines: ReturnType<DatabaseSync["prepare"]>;
}

const permissionStatements = new WeakMap<DatabaseSync, PermissionStatements>();

function statements(db: DatabaseSync): PermissionStatements {
  let held = permissionStatements.get(db);
  if (held === undefined) {
    held = {
      account: db.prepare("SELECT agent_messaging_off, updated_at FROM account_permissions WHERE user_id = ?"),
      machine: db.prepare("SELECT agent_messaging_off, isolated, updated_at FROM machine_permissions WHERE machine_id = ?"),
      clock: db.prepare(
        "SELECT MAX(at) AS at FROM (" +
          "SELECT MAX(updated_at) AS at FROM account_permissions UNION ALL " +
          "SELECT MAX(updated_at) AS at FROM machine_permissions)",
      ),
      writeAccount: db.prepare(
        "INSERT INTO account_permissions (user_id, agent_messaging_off, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET agent_messaging_off = excluded.agent_messaging_off, " +
          "updated_at = excluded.updated_at",
      ),
      writeMachine: db.prepare(
        "INSERT INTO machine_permissions (machine_id, agent_messaging_off, isolated, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(machine_id) DO UPDATE SET agent_messaging_off = excluded.agent_messaging_off, " +
          "isolated = excluded.isolated, updated_at = excluded.updated_at",
      ),
      offMachines: db.prepare(
        "SELECT p.machine_id AS machine_id FROM machine_permissions p " +
          "JOIN machine_owners o ON o.machine_id = p.machine_id " +
          "WHERE o.user_id = ? AND p.agent_messaging_off = 1",
      ),
      isolatedMachines: db.prepare(
        "SELECT p.machine_id AS machine_id FROM machine_permissions p " +
          "JOIN machine_owners o ON o.machine_id = p.machine_id " +
          "WHERE o.user_id = ? AND p.isolated = 1",
      ),
    };
    permissionStatements.set(db, held);
  }
  return held;
}

function policyOf(row: Record<string, unknown> | undefined): MessagingPolicy {
  if (row === undefined) return { on: true, at: 0 };
  return { on: Number(row["agent_messaging_off"]) === 0, at: Number(row["updated_at"]) };
}

export function accountMessaging(db: DatabaseSync, userId: string): MessagingPolicy {
  return policyOf(statements(db).account.get(userId));
}

/** The machine's own row, without its owner's. */
export function machineMessaging(db: DatabaseSync, machineId: string): MachinePermission {
  const row = statements(db).machine.get(machineId);
  return { ...policyOf(row), isolated: row !== undefined && Number(row["isolated"]) === 1 };
}

/** What the machine's daemon must enforce: the owner's account row and the machine's own, both on. */
export function messagingPolicy(db: DatabaseSync, ownerId: string, machineId: string): MachinePolicy {
  const account = accountMessaging(db, ownerId);
  const machine = machineMessaging(db, machineId);
  return { on: account.on && machine.on, isolated: machine.isolated, at: Math.max(account.at, machine.at) };
}

/** Of the machines this user owns, those whose own row is off. */
export function messagingOffMachineIds(db: DatabaseSync, userId: string): Set<string> {
  return new Set(statements(db).offMachines.all(userId).map((row) => String(row["machine_id"])));
}

/** Of the machines this user owns, those whose own row keeps their sessions to themselves. */
export function isolatedMachineIds(db: DatabaseSync, userId: string): Set<string> {
  return new Set(statements(db).isolatedMachines.all(userId).map((row) => String(row["machine_id"])));
}

/** Above every stamp either table holds, so any machine's policy moves forward whichever row a write touched. */
export function nextPolicyAt(db: DatabaseSync, now = Date.now()): number {
  const clock = statements(db).clock.get()?.["at"];
  return Math.max(now, clock === null || clock === undefined ? 0 : Number(clock) + 1);
}

export function writeAccountMessaging(db: DatabaseSync, userId: string, on: boolean, at: number): void {
  statements(db).writeAccount.run(userId, on ? 0 : 1, at);
}

export function writeMachineMessaging(
  db: DatabaseSync,
  machineId: string,
  held: { on: boolean; isolated: boolean },
  at: number,
): void {
  statements(db).writeMachine.run(machineId, held.on ? 0 : 1, held.isolated ? 1 : 0, at);
}
