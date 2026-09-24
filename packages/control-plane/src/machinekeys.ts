import type { DatabaseSync } from "node:sqlite";

// Trust on first use: pin the first key, accept the same one, refuse a different one. Only re-enrollment replaces it.

export type MachineKeyPin = "pinned" | "unchanged" | "mismatch";

/** One conditional UPDATE, so the first of two racing dials wins and the second falls through to the comparison. */
export function pinMachineKey(db: DatabaseSync, machineId: string, announced: string, now = Date.now()): MachineKeyPin {
  const claimed = db
    .prepare("UPDATE machines SET machine_key = ?, machine_key_set_at = ? WHERE id = ? AND machine_key IS NULL")
    .run(announced, now, machineId);
  if (claimed.changes === 1) return "pinned";

  const held = machineKeyFor(db, machineId);
  // null means the row is gone, which is not a key disagreement.
  if (held === null) return "unchanged";
  return held === announced ? "unchanged" : "mismatch";
}

export function machineKeyFor(db: DatabaseSync, machineId: string): string | null {
  const row = db.prepare("SELECT machine_key FROM machines WHERE id = ?").get(machineId);
  if (!row) return null;
  return row["machine_key"] == null ? null : String(row["machine_key"]);
}

export function setMachineKey(db: DatabaseSync, machineId: string, announced: string, now = Date.now()): void {
  db.prepare("UPDATE machines SET machine_key = ?, machine_key_set_at = ? WHERE id = ?").run(announced, now, machineId);
}
