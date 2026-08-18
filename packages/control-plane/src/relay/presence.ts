import type { DatabaseSync } from "node:sqlite";
import type { RelayView, TunnelStats } from "./registry.js";

/**
 * Which machines hold a tunnel, as a row rather than as a `Map`.
 *
 * The relay runs in its own process now, so `app.ts` cannot ask a
 * `TunnelRegistry` whether a machine is online — and it asks in two places that
 * matter: `relayOnline`, which decides whether `POST /v1/tokens` hands a client
 * a route at all, and `GET /v1/admin/relay`. This is that answer, written by the
 * relay and read by the API.
 *
 * **Only the presence moves, never the tunnel.** A tunnel is a TLS-wrapped
 * WebSocket carrying an HTTP/2 session — a kernel fd plus TLS keys, h2 stream
 * tables, flow-control windows and ws framing state, all in one process's heap.
 * `child.send(socket)` passes the fd and none of the rest, so the peer would see
 * a corrupted stream. There is no serialization and no handoff: a relay restart
 * always costs a redial, and nothing in this file pretends otherwise. What it
 * removes is the *coupling*, not the reconnect.
 *
 * Everything here is **best-effort**. There are two writers on this database
 * now and the busy timeout is 250ms, so a `SQLITE_BUSY` must cost one stale row
 * for one tick and must never propagate into a tunnel's lifecycle — a machine
 * that is up but momentarily unwritable is still up.
 */

/**
 * How often live tunnels are re-stamped.
 *
 * Short, because it bounds two visible windows: how long a machine that just
 * dialled in can read as offline if its `up` write lost a race, and how long a
 * hard-killed relay's rows keep claiming machines are present. One small write
 * transaction every few seconds against a database that otherwise sees a
 * handful of writes per administrative action.
 */
export const PRESENCE_FLUSH_INTERVAL_MS = 5_000;

/**
 * How old a row may be and still count as a live tunnel.
 *
 * Four flushes. The asymmetry is deliberate and is the whole reason this is a
 * window rather than a boolean: a stale `true` costs one probe and then a
 * `503 no_tunnel`, which `meansMachineGone` already turns into `forgetRoute()`
 * — self-correcting, one round trip. A stale `false` draws a reachable machine
 * as offline and the client never probes it (`machine.ts` returns `no_route`
 * without asking), so there is nothing to correct it. Generous, therefore.
 */
export const PRESENCE_STALE_MS = 20_000;

/**
 * The deployment slot, not the process.
 *
 * A relay that is killed hard cannot clear its own rows, so its replacement
 * clears them by name at boot. That only works while the name is stable across
 * restarts, which is why this is a fixed default rather than anything derived
 * from a pid, a hostname or a container id.
 */
export const DEFAULT_RELAY_ID = "relay";

export interface PresenceWriter {
  /** A tunnel registered. Upsert, because newest wins in the registry too. */
  up(machineId: string, connectedAt: number): void;
  /** A tunnel unregistered. Immediacy only — a lost delete goes stale on its own. */
  down(machineId: string): void;
  /** Re-stamp what is live and delete what this relay no longer holds. */
  flush(live: readonly TunnelStats[]): void;
  /** Drop every row this relay id owns. Run at boot, before the listener is up. */
  clear(): void;
}

export interface PresenceOptions {
  relayId?: string;
  /**
   * This process's claim on the slot, so the flush can keep it alive.
   *
   * Defaulted to the empty string, which matches no row — an embedded control
   * plane and every offline driver hold no claim and should stamp nobody's.
   */
  nonce?: string;
  now?: () => number;
  onEvent?: (event: string, detail: string) => void;
}

export function createPresenceWriter(db: DatabaseSync, options: PresenceOptions = {}): PresenceWriter {
  const relayId = options.relayId ?? DEFAULT_RELAY_ID;
  const nonce = options.nonce ?? "";
  const now = options.now ?? Date.now;
  const onEvent = options.onEvent ?? ((): void => {});

  /*
   * Prepared once, for the same reason `store.ts` prepares its three: these run
   * on the event loop that carries every tunnel in the fleet, and re-compiling
   * SQL on a heartbeat is a cost nobody would find later.
   */
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
  /**
   * The heartbeat's own statement, and it may **not** take a row from another
   * relay.
   *
   * ⚠ **The flush used to share `upsert` above**, which re-stamps `relay_id`
   * unconditionally. That is right for `up` — a daemon that has just dialled in
   * is authoritative, and "newest wins" is the rule the registry enforces one
   * layer up — and wrong every five seconds for a relay that is merely still
   * running. A tunnel stays in a relay's map until its ping tick notices the
   * socket is gone (20 s × 2 misses), so a daemon that blipped and redialled
   * onto relay B had its row stolen back by relay A's heartbeat for up to forty
   * seconds, and `relayFor` named the relay holding the corpse.
   *
   * Invisible while there was one relay, which is why the shared statement was
   * fine until `relayFor` gave the column a reader.
   *
   * So the write happens on one of two conditions: the row is already ours, or
   * the tunnel we are describing is **newer** than the one the row describes.
   * `connected_at` is the tunnel's own `since`, so a genuine redial is strictly
   * later and ownership still transfers on the case that should transfer it —
   * including when an `up` write lost a race, which is the repair the flush
   * exists for. A stale relay carries the *old* `since` and loses both ways.
   *
   * The predicate is on the conflict rather than the SET list, deliberately:
   * dropping `relay_id` from the SET would block the theft too, and would also
   * stop the flush ever repairing a lost `up` — a restriction where what is
   * wanted is an ordering.
   */
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
  /**
   * When this machine was last known to be connected, which outlives the tunnel.
   *
   * The row in `relay_tunnels` is deleted on disconnect — that is what makes it
   * presence — so nothing anywhere could tell a lid that closed a minute ago from
   * a host that died last week. Both drew as "offline".
   *
   * `MAX(...)` rather than a plain assignment: two relays can hold rows for one
   * machine for a few seconds around a redial (the old one until its ping tick),
   * and the *later* observation is the true one whichever process writes last.
   * Without it a stale relay's flush would walk the answer backwards.
   */
  const seen = db.prepare(
    "INSERT INTO machine_last_seen (machine_id, at) VALUES (?, ?) " +
      "ON CONFLICT(machine_id) DO UPDATE SET at = MAX(machine_last_seen.at, excluded.at)",
  );

  /**
   * Every write in this file goes through here.
   *
   * There is exactly one rule and it is the reason the wrapper exists rather
   * than a `try` at each call site: a presence write may fail, and the tunnel it
   * describes is unaffected by that failure. The flush below repairs whatever
   * was missed.
   */
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
        // Stamped here as well as on the flush, so a machine that dialled in and
        // dropped inside one five-second tick still has a record of having been
        // there — which is exactly the machine somebody is trying to diagnose.
        seen.run(machineId, at);
      });
    },

    down(machineId) {
      /*
       * Scoped to this relay id, which is the row-level echo of the identity
       * check `TunnelRegistry.unregister` makes before it calls this: a delete
       * that is not about the tunnel currently registered must not fire. The
       * caller's guard is the real protection; this is the one that survives a
       * second relay arriving later.
       */
      guarded(`down ${machineId}`, () => {
        remove.run(machineId, relayId);
      });
    },

    flush(live) {
      /*
       * One transaction, and the sweep is what makes the whole thing
       * self-correcting rather than merely current. Everything live is stamped
       * with the same `at`; anything this relay owns that was *not* stamped is
       * therefore older and gets deleted — so a lost `up` is repaired within one
       * tick and a lost `down` costs one tick rather than a whole stale window.
       * No `IN (...)` list, no variable arity, and no second pass over the map.
       */
      const at = now();
      guarded("flush", () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of live) {
            refresh.run(row.machineId, relayId, row.since, at, row.requestsProxied, row.activeStreams);
            // Unconditional, unlike `refresh` above: that statement refuses to
            // take a row from another relay, and this one is not about ownership
            // at all — a machine seen by *any* relay was seen.
            seen.run(row.machineId, at);
          }
          sweep.run(relayId, at);
          /*
           * The slot's heartbeat, on the transaction that already exists.
           *
           * `claimRelayId` refuses a name whose holder is still flushing, so
           * something has to keep saying so — and a relay with no tunnels at all
           * still owns its name, which is why this is here rather than inside
           * the loop above.
           *
           * Identity-checked: a relay that lost its claim (its row was taken
           * over after a long pause) must not silently take it back on a
           * heartbeat. It keeps serving the tunnels it holds and its rows go
           * stale, which is the same answer `refresh` gives one statement up.
           */
          beat.run(at, relayId, nonce);
          db.exec("COMMIT");
        } catch (error) {
          // A `BEGIN` left open takes out the *next* writer on this handle, which
          // is the one failure mode a best-effort write must not have.
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

/**
 * Start the periodic flush, returning the way to stop it.
 *
 * `unref`'d: this must never be the thing keeping a process alive, and a relay
 * that is shutting down has already stopped caring what its rows say.
 */
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

/**
 * The reader: `RelayView` over the table instead of over a `Map`.
 *
 * A second implementation of the interface `app.ts` already takes, which is why
 * `app.ts` does not change for any of this — the registry's own comment calls
 * that seam out as the point of the interface, and this is it being used.
 *
 * Rows past the staleness window are invisible to **both** methods, so
 * `GET /v1/admin/relay` cannot list a tunnel that `isOnline` denies.
 */
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
        // Reading presence is not authorization. A database that will not answer
        // must not be reported as "this machine is definitely down" — but there
        // is no third answer on this interface, and `false` is the one a client
        // can recover from by re-resolving. Nothing is *granted* by either.
        return false;
      }
    },

    /**
     * Which relay holds it — the whole reason `relay_id` is a column.
     *
     * The same staleness window as `isOnline`, and it has to be: a row this view
     * calls absent must not still be able to name somewhere for a browser to
     * dial. Getting that wrong would send a client to a relay that no longer
     * holds the tunnel, which costs a `503 no_tunnel` and a re-resolve — the
     * error is recoverable, but disagreeing with ourselves inside one view is
     * the kind of thing nobody would think to look for.
     */
    relayFor(machineId) {
      try {
        const row = which.get(machineId, now() - staleMs);
        return row === undefined ? null : String(row["relay_id"]);
      } catch {
        // A database that will not answer. `null` for `isOnline`'s reason —
        // nothing is granted here, and a caller that gets nothing falls back to
        // the default relay rather than to an error.
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

/**
 * How long a relay's claim on its slot outlives its last heartbeat.
 *
 * Four flushes, the same arithmetic as `PRESENCE_STALE_MS` and for a mirrored
 * reason. Too short and an ordinary GC pause hands the name to a second relay
 * while the first is still serving; too long and a relay that was killed hard
 * blocks its own replacement, which is the fleet's only entrance.
 *
 * A *planned* stop does not pay it at all — `releaseRelayId` runs on SIGTERM,
 * so a deploy reclaims the name instantly. This window is only what a crash
 * costs.
 */
export const RELAY_CLAIM_STALE_MS = 20_000;

export type RelayClaim =
  | { ok: true }
  | { ok: false; heldBy: string; lastSeenMsAgo: number };

/**
 * Claim a relay slot, or refuse because a live process already holds it.
 *
 * ⚠ **Two relays under one `REEMOAT_CP_RELAY_ID` delete each other's rows every
 * five seconds.** `sweep` removes rows carrying this relay's name that this
 * relay's own flush did not stamp — which is exactly every machine on the
 * *other* one. The fleet flaps between reachable and offline and nothing says
 * why. That was documented and enforced by nothing, which is the failure mode
 * this repository is least willing to leave standing.
 *
 * The daemon's `claimDaemonLock` is the precedent and the shape differs in one
 * way that matters: a relay runs in a container, so `pid` and `os.uptime()` are
 * meaningless across namespaces. Liveness is a **heartbeat** instead, stamped by
 * the flush that already runs, and `nonce` is what distinguishes two processes
 * under one name.
 *
 * **Taking over a stale claim is the normal path, not an edge case.** A relay
 * killed hard leaves its row behind exactly as it leaves its tunnel rows behind,
 * and `RELAY_CLAIM_STALE_MS` is when the replacement may have the name. What is
 * refused is only a claim that is *fresh*, i.e. somebody is alive and flushing.
 */
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

/**
 * Give the slot back, on the way out.
 *
 * Identity-checked for `unregister`'s reason one table over: a process that no
 * longer holds the name must not release it on behalf of the one that does.
 * Without the check, a relay refused at boot would clear the live relay's claim
 * on its way to `exit(2)` — turning a refusal that protects the fleet into the
 * collision it exists to prevent.
 */
export function releaseRelayId(db: DatabaseSync, relayId: string, nonce: string): void {
  try {
    db.prepare("DELETE FROM relay_instances WHERE relay_id = ? AND nonce = ?").run(relayId, nonce);
  } catch {
    // Best-effort, like every other write in this file. A claim nobody released
    // goes stale on its own, which is the case `RELAY_CLAIM_STALE_MS` is for.
  }
}
