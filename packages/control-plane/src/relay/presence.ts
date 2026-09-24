import type { DatabaseSync } from "node:sqlite";
import type { RelayView, TunnelStats } from "./registry.js";

// Tunnel presence as rows, written by the relay and read by the API. Best-effort: a failed write costs one stale tick.

export const PRESENCE_FLUSH_INTERVAL_MS = 5_000;

/** Generous on purpose: a stale true self-corrects through 503 no_tunnel, while a stale false is never probed. */
export const PRESENCE_STALE_MS = 20_000;

/** Fixed rather than per-process, so a replacement can clear a hard-killed relay's rows by name. */
export const DEFAULT_RELAY_ID = "relay";

export interface PresenceWriter {
  up(machineId: string, connectedAt: number): void;
  /** A tunnel unregistered. Immediacy only — a lost delete goes stale on its own. */
  down(machineId: string): void;
  flush(live: readonly TunnelStats[]): void;
  clear(): void;
}

export interface PresenceOptions {
  relayId?: string;
  // Empty by default, which matches no row: an embedded control plane or a driver holds no slot claim.
  nonce?: string;
  now?: () => number;
  onEvent?: (event: string, detail: string) => void;
}

export function createPresenceWriter(db: DatabaseSync, options: PresenceOptions = {}): PresenceWriter {
  const relayId = options.relayId ?? DEFAULT_RELAY_ID;
  const nonce = options.nonce ?? "";
  const now = options.now ?? Date.now;
  const onEvent = options.onEvent ?? ((): void => {});

  const upsert = db.prepare(
    `INSERT INTO relay_tunnels (machine_id, relay_id, connected_at, last_seen_at, requests_proxied, active_streams)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       relay_id = excluded.relay_id,
       connected_at = excluded.connected_at,
       last_seen_at = excluded.last_seen_at,
       requests_proxied = excluded.requests_proxied,
       active_streams = excluded.active_streams`,
  );
  // Unlike upsert, takes a row from another relay only for a newer tunnel, so a stale relay's heartbeat cannot steal a redialled machine.
  const refresh = db.prepare(
    `INSERT INTO relay_tunnels (machine_id, relay_id, connected_at, last_seen_at, requests_proxied, active_streams)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine_id) DO UPDATE SET
       relay_id = excluded.relay_id,
       connected_at = excluded.connected_at,
       last_seen_at = excluded.last_seen_at,
       requests_proxied = excluded.requests_proxied,
       active_streams = excluded.active_streams
     WHERE relay_tunnels.relay_id = excluded.relay_id
        OR excluded.connected_at >= relay_tunnels.connected_at`,
  );
  const remove = db.prepare("DELETE FROM relay_tunnels WHERE machine_id = ? AND relay_id = ?");
  const sweep = db.prepare("DELETE FROM relay_tunnels WHERE relay_id = ? AND last_seen_at < ?");
  const clearAll = db.prepare("DELETE FROM relay_tunnels WHERE relay_id = ?");
  const beat = db.prepare("UPDATE relay_instances SET last_seen_at = ? WHERE relay_id = ? AND nonce = ?");
  // Outlives the tunnel row. MAX because two relays can both report one machine around a redial.
  const seen = db.prepare(
    "INSERT INTO machine_last_seen (machine_id, at) VALUES (?, ?) " +
      "ON CONFLICT(machine_id) DO UPDATE SET at = MAX(machine_last_seen.at, excluded.at)",
  );

  // A presence write may fail without affecting its tunnel; the flush repairs whatever was missed.
  const guarded = (what: string, write: () => void): void => {
    try {
      write();
    } catch (error) {
      onEvent("presence_write_failed", `${what}: ${(error as Error).message}`);
    }
  };

  return {
    up(machineId, connectedAt) {
      guarded(`up ${machineId}`, () => {
        const at = now();
        upsert.run(machineId, relayId, connectedAt, at, 0, 0);
        seen.run(machineId, at);
      });
    },

    down(machineId) {
      // Scoped to this relay id, so a delete never removes another relay's row.
      guarded(`down ${machineId}`, () => {
        remove.run(machineId, relayId);
      });
    },

    flush(live) {
      // Everything live gets the same at, so the sweep deletes whatever this relay owns that was not re-stamped.
      const at = now();
      guarded("flush", () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of live) {
            refresh.run(row.machineId, relayId, row.since, at, row.requestsProxied, row.activeStreams);
            seen.run(row.machineId, at);
          }
          sweep.run(relayId, at);
          // The slot heartbeat, identity-checked so a relay that lost its claim cannot take it back.
          beat.run(at, relayId, nonce);
          db.exec("COMMIT");
        } catch (error) {
          // A BEGIN left open would take out the next writer on this handle.
          try {
            db.exec("ROLLBACK");
          } catch {
            // Nothing was open; the throw below is the real report.
          }
          throw error;
        }
      });
    },

    clear() {
      guarded("clear", () => {
        clearAll.run(relayId);
      });
    },
  };
}

export function startPresenceFlush(
  writer: PresenceWriter,
  view: RelayView,
  intervalMs: number = PRESENCE_FLUSH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => writer.flush(view.stats()), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RelayViewOptions {
  staleMs?: number;
  now?: () => number;
}

/** RelayView over the table. Rows past the staleness window are invisible to every method. */
export function dbRelayView(db: DatabaseSync, options: RelayViewOptions = {}): RelayView {
  const staleMs = options.staleMs ?? PRESENCE_STALE_MS;
  const now = options.now ?? Date.now;

  const one = db.prepare("SELECT last_seen_at FROM relay_tunnels WHERE machine_id = ? AND last_seen_at >= ?");
  const which = db.prepare("SELECT relay_id FROM relay_tunnels WHERE machine_id = ? AND last_seen_at >= ?");
  const all = db.prepare(
    `SELECT machine_id, relay_id, connected_at, requests_proxied, active_streams
       FROM relay_tunnels
      WHERE last_seen_at >= ?
      ORDER BY connected_at ASC`,
  );

  return {
    isOnline(machineId) {
      try {
        return one.get(machineId, now() - staleMs) !== undefined;
      } catch {
        // Presence is not authorization: false on a failed read is the answer a client recovers from by re-resolving.
        return false;
      }
    },

    // Same staleness window as isOnline, so a row that reads absent never names a relay to dial.
    relayFor(machineId) {
      try {
        const row = which.get(machineId, now() - staleMs);
        return row === undefined ? null : String(row["relay_id"]);
      } catch {
        return null;
      }
    },

    stats() {
      try {
        return all.all(now() - staleMs).map((row) => ({
          machineId: String(row["machine_id"]),
          relayId: String(row["relay_id"]),
          since: Number(row["connected_at"]),
          activeStreams: Number(row["active_streams"]),
          requestsProxied: Number(row["requests_proxied"]),
        }));
      } catch {
        return [];
      }
    },
  };
}

/** Four flushes. Only a crash pays it: releaseRelayId runs on SIGTERM. */
export const RELAY_CLAIM_STALE_MS = 20_000;

export type RelayClaim =
  | { ok: true }
  | { ok: false; heldBy: string; lastSeenMsAgo: number };

/** Refuses only a fresh claim, since two relays under one REEMOAT_CP_RELAY_ID would sweep each other's rows. A stale claim is taken over. */
export function claimRelayId(
  db: DatabaseSync,
  relayId: string,
  nonce: string,
  now = Date.now(),
): RelayClaim {
  const held = db.prepare("SELECT nonce, last_seen_at FROM relay_instances WHERE relay_id = ?").get(relayId);
  if (held !== undefined && String(held["nonce"]) !== nonce) {
    const lastSeen = Number(held["last_seen_at"]);
    if (now - lastSeen < RELAY_CLAIM_STALE_MS) {
      return { ok: false, heldBy: String(held["nonce"]), lastSeenMsAgo: now - lastSeen };
    }
  }
  db.prepare(
    "INSERT INTO relay_instances (relay_id, nonce, claimed_at, last_seen_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(relay_id) DO UPDATE SET nonce = excluded.nonce, " +
      "claimed_at = excluded.claimed_at, last_seen_at = excluded.last_seen_at",
  ).run(relayId, nonce, now, now);
  return { ok: true };
}

/** Identity-checked, so a relay refused at boot cannot release the live relay's claim. */
export function releaseRelayId(db: DatabaseSync, relayId: string, nonce: string): void {
  try {
    db.prepare("DELETE FROM relay_instances WHERE relay_id = ? AND nonce = ?").run(relayId, nonce);
  } catch {
    // Best-effort; an unreleased claim goes stale after RELAY_CLAIM_STALE_MS.
  }
}
