import type { DatabaseSync } from "node:sqlite";
import { MAX_DAEMON_VERSION_CHARS, formatAgentClis, parseAgentClis } from "../../../src/relay/protocol.js";
import { newId } from "./keys.js";

export const MACHINE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Refuses labels spelled like a machine id, in both widths newId has minted (8 and 16 hex), so a label can never shadow an id. */
export const MACHINE_LABEL_RESERVED = /^m_(?:[0-9a-f]{8}|[0-9a-f]{16})$/;

export const MACHINE_LABEL_HELP =
  "name may contain letters, digits, and . _ - only, and must start with a letter or digit";

// Names the shape rather than a width: relaycheck asserts the 400 equals this constant.
export const MACHINE_LABEL_RESERVED_HELP = "name may not be spelled like a machine id (m_ followed by hex digits)";

/** Both label rules in one call. The caller trims first. */
export function labelIsWellFormed(label: string): boolean {
  return MACHINE_LABEL.test(label) && !MACHINE_LABEL_RESERVED.test(label);
}

/** The anti-abuse ceiling. The configurable limit (quota.ts) can only ever be lower. */
export const MAX_MACHINES_PER_USER = 50;

/** machines.name is globally unique, so the id is appended; people are shown machine_owners.label instead. */
export function qualifiedName(label: string, machineId: string): string {
  return `${label}-${machineId.replace(/^m_/, "")}`;
}

export interface OwnedMachine {
  id: string;
  label: string;
  userId: string;
}

/** Who owns this machine, or `null` for one that predates ownership. */
export function ownerOf(db: DatabaseSync, machineId: string): OwnedMachine | null {
  const row = db.prepare("SELECT machine_id, user_id, label FROM machine_owners WHERE machine_id = ?").get(machineId);
  if (!row) return null;
  return { id: String(row["machine_id"]), label: String(row["label"]), userId: String(row["user_id"]) };
}

/** Id first, then the caller's own label, then machines.name; never another user's label. Id first so no label can shadow an id. */
export function resolveMachineRef(db: DatabaseSync, userId: string, ref: string): string | null {
  const byId = db.prepare("SELECT id FROM machines WHERE id = ?").get(ref);
  if (byId) return String(byId["id"]);

  const owned = db
    .prepare("SELECT machine_id FROM machine_owners WHERE user_id = ? AND label = ?")
    .get(userId, ref);
  if (owned) return String(owned["machine_id"]);

  const byName = db.prepare("SELECT id FROM machines WHERE name = ?").get(ref);
  return byName ? String(byName["id"]) : null;
}

/** The caller's own label when they own the machine, else the row's name; never another user's label. */
export function labelOrName(label: unknown, rowName: string): string {
  return label === null || label === undefined ? rowName : String(label);
}

export type CreateRefusal = "label_taken" | "too_many";

/** node:sqlite exposes no error code, so this matches the message. */
export function isUniqueViolation(error: unknown): boolean {
  return String(error).includes("UNIQUE");
}

/** Call inside the revoke transaction: frees the label, quota slot and rank. The machines row stays. */
export function releaseOwner(db: DatabaseSync, machineId: string): number {
  return Number(db.prepare("DELETE FROM machine_owners WHERE machine_id = ?").run(machineId).changes);
}

/** Case-folded, and wider than the per-owner index: includes shared and legacy machines. */
export function nameVisibleTo(db: DatabaseSync, userId: string, label: string, exceptMachineId?: string): boolean {
  const rows = db
    .prepare(
      "SELECT m.id, m.name, o.label FROM grants g " +
        "JOIN machines m ON m.id = g.machine_id " +
        "LEFT JOIN machine_owners o ON o.machine_id = m.id AND o.user_id = g.user_id " +
        "WHERE g.user_id = ? AND m.revoked_at IS NULL",
    )
    .all(userId);
  return rows.some((row) => {
    if (exceptMachineId !== undefined && String(row["id"]) === exceptMachineId) return false;
    const shown = labelOrName(row["label"], String(row["name"]));
    return shown.toLowerCase() === label.toLowerCase();
  });
}

/** Known gap: a grant can still make two same-named machines visible; POST /v1/tokens still checks the grant. */
export function nameVisibleToGrantees(db: DatabaseSync, machineId: string, name: string): boolean {
  const owner = ownerOf(db, machineId);
  const grantees = db.prepare("SELECT user_id FROM grants WHERE machine_id = ?").all(machineId);
  return grantees.some((row) => {
    const userId = String(row["user_id"]);
    if (owner !== null && userId === owner.userId) return false;
    return nameVisibleTo(db, userId, name, machineId);
  });
}

/** Machine, ownership and grant in one transaction. `limit` has no default; MAX_MACHINES_PER_USER is re-applied here. */
export function createOwnedMachine(
  db: DatabaseSync,
  userId: string,
  label: string,
  scopes: readonly string[],
  limit: number,
  now = Date.now(),
): { id: string; name: string } | { error: CreateRefusal } {
  const owned = Number(
    db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?").get(userId)?.["n"] ?? 0,
  );
  if (owned >= Math.min(limit, MAX_MACHINES_PER_USER)) return { error: "too_many" };

  const id = newId("m");
  const name = qualifiedName(label, id);

  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now);
    db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      userId,
      label,
      now,
    );
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      userId,
      id,
      scopes.join(" "),
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    // Only the (user_id, label) index can trip here: machines.name is unique by construction.
    if (isUniqueViolation(error)) return { error: "label_taken" };
    throw error;
  }

  return { id, name };
}

/** `user_id` in the WHERE makes a non-owner's call a no-op. */
export function relabelMachine(
  db: DatabaseSync,
  machineId: string,
  userId: string,
  label: string,
): { error: CreateRefusal } | null {
  try {
    db.prepare("UPDATE machine_owners SET label = ? WHERE machine_id = ? AND user_id = ?").run(
      label,
      machineId,
      userId,
    );
  } catch (error) {
    // Only the (user_id, label) index can be tripped by a rename.
    if (isUniqueViolation(error)) return { error: "label_taken" };
    throw error;
  }
  return null;
}

/** A display label, never parsed or branched on. */
export function readDaemonVersionHeader(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[^\x20-\x7e]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_DAEMON_VERSION_CHARS);
}

/** Refused whole (null) rather than cut, stored in parseAgentClis's canonical form. */
export function readAgentClisHeader(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const parsed = parseAgentClis(value.trim());
  return parsed === null ? null : formatAgentClis(parsed);
}

export interface DaemonBuild {
  daemonVersion: string | null;
  protocolVersion: number;
  agentClis: string | null;
  at: number;
}

export function recordDaemonBuild(db: DatabaseSync, machineId: string, build: DaemonBuild): void {
  try {
    db.prepare(
      "UPDATE machines SET daemon_version = ?, daemon_protocol = ?, daemon_agents = ?, daemon_seen_at = ? WHERE id = ?",
    ).run(build.daemonVersion, build.protocolVersion, build.agentClis, build.at, machineId);
  } catch {
    // Reporting, not deciding: a tunnel dial must not fail for this.
  }
}
