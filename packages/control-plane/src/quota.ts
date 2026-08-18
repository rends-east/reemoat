import type { DatabaseSync } from "node:sqlite";
import { MAX_MACHINES_PER_USER } from "./machines.js";
import { readInteger } from "./settings.js";

/**
 * How many machines a person may run, and which of theirs are switched off.
 *
 * **Over the limit is derived, never stored.** A machine is over iff its *rank*
 * among its owner's machines — ordered by `(machine_owners.created_at,
 * machine_id)` ascending — is `>= effectiveLimit(owner)`. There is no
 * `suspended` column, no sweep, and nothing to recompute on any of the six paths
 * that mutate ownership. Lowering the limit takes the most recently acquired
 * machines off the network; raising it hands them back on the next request, with
 * nobody touching the host.
 *
 * Three things fall out of that and none of them is free anywhere else:
 *
 *   - **Raising un-suspends.** A stored flag needs a writer on every path that
 *     could change the answer, and the one that gets forgotten is the one that
 *     leaves somebody's machine dark after the admin already fixed it.
 *   - **Revoking promotes.** `releaseOwner` DELETEs the ownership row, so every
 *     surviving rank decrements: revoke machine #2 of five under a limit of
 *     three and #4 starts working, with no code in this file and none in that
 *     one.
 *   - **A create/count race cannot overshoot the bound.** If two creates ever
 *     did pass one count, the extra machine is simply rank >= limit and does not
 *     work. That is why nothing here needs a transaction it does not already
 *     have.
 *
 * **Ordering is by acquisition, and it is emphatically not by last tunnel
 * connection.** That was the tempting reading of "the most recently connected
 * machine stops working", and it oscillates: the suspended machine cannot
 * connect, so its last-connect timestamp stays old, so it becomes the *oldest*,
 * so it un-suspends and takes the other one down instead — on every poll,
 * for ever.
 *
 * **The tiebreak on `machine_id` is not tidiness.** `created_at` is
 * `Date.now()`, and two machines acquired in the same millisecond are reachable
 * from a script. Without the second half of the comparison both rows count zero
 * older siblings, both report rank 0, and a user with a limit of 1 keeps two
 * working machines — the bound wrong by one, silently, which is the only way a
 * commercial limit fails that nobody notices.
 *
 * **`rowid` was considered as the ordering and rejected.** `releaseOwner`
 * DELETEs, and SQLite reuses rowids unless the table is `AUTOINCREMENT`, so a
 * revoke-then-create would silently reorder somebody's fleet. `created_at` is
 * also the column an admin can read and reason about.
 *
 * **Quota is evaluated after a grant is proved, everywhere, and that ordering is
 * load-bearing.** `relay/authorize.ts` and `POST /v1/tokens` both answer the
 * same refusal for "no such machine" and "no grant" precisely so a caller cannot
 * map the fleet; this check names a real state, which is the point, because the
 * owner has to be able to see why their machine stopped. Asked *before* the
 * grant it would be an enumeration oracle — any valid token would tell you
 * whether an arbitrary `aud` exists and is over its owner's limit.
 *
 * **Two bounds, and they are different.** `MAX_MACHINES_PER_USER` is the
 * anti-abuse ceiling with its own measurement, reachable by anybody with a
 * password. The setting here is the commercial limit an admin raises to sell.
 * Collapsing them means an admin who types 500 for a customer has silently
 * removed the database-growth bound, and the failure is not a refusal but a slow
 * instance. So the ceiling is refused on write *and* clamped on read.
 *
 * **Clock movement is a known limitation.** `created_at` is wall-clock, so a
 * backwards step (an NTP correction, a restored VM) can sort a newly acquired
 * machine before an older one and suspend the wrong one. The *count* is
 * unaffected, so the commercial bound holds; only the choice of victim is wrong.
 * The fix is a monotonic sequence column, and it is a change somebody can now
 * make: `store.ts` grew a `migrate()` with the release-compatibility work, and an
 * additive nullable column is exactly what that function is for. It was blocked
 * when this was written and is not any more — what is left is the deciding, not
 * the mechanism.
 */

/* ------------------------------------------------------------------ *
 * Statements
 *
 * Its own cache rather than joining `store.ts`'s, which is documented as "the
 * three readers `authorize` asks". The rank SQL and the rule that interprets it
 * are one rule, and splitting them across two files is how the tiebreak comes to
 * be dropped from one of them.
 * ------------------------------------------------------------------ */

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
      /*
       * A machine's position among its owner's, and its owner's override, in one
       * row. This is the relay's per-request question, so it is one statement
       * rather than three: the owner, the rank and the override together.
       *
       * The row-value comparison `(a, b) < (c, d)` is SQLite >= 3.15 and does
       * both jobs in one expression — order by acquisition, break ties on the
       * id. Against `idx_machine_owners_rank (user_id, created_at, machine_id)`
       * the count is a covering scan bounded by that owner's own row count,
       * which `MAX_MACHINES_PER_USER` bounds at fifty.
       */
      standing: db.prepare(
        "SELECT o.user_id AS user_id, " +
          "  (SELECT COUNT(*) FROM machine_owners p " +
          "     WHERE p.user_id = o.user_id " +
          "       AND (p.created_at, p.machine_id) < (o.created_at, o.machine_id)) AS rank, " +
          "  (SELECT l.max_machines FROM user_machine_limits l WHERE l.user_id = o.user_id) AS override, " +
          // The owner's ban, on the same row and therefore free. A second
          // statement for it would be a second read on the relay's per-request
          // path for a fact this one already has the join to reach.
          "  (SELECT u.disabled_at FROM users u WHERE u.id = o.user_id) AS owner_disabled " +
          "FROM machine_owners o WHERE o.machine_id = ?",
      ),
      // The same statement `createOwnedMachine` runs, with the same deliberate
      // absence of a revoked filter: revoking DELETEs the ownership row.
      count: db.prepare("SELECT COUNT(*) AS n FROM machine_owners WHERE user_id = ?"),
      override: db.prepare("SELECT max_machines FROM user_machine_limits WHERE user_id = ?"),
      // `LIMIT -1 OFFSET ?` is SQLite's "everything past n". The same rule as
      // `standing`, written the way a human reads it — which is what an admin
      // route reports back after a lowering.
      tail: db.prepare(
        "SELECT machine_id, label FROM machine_owners WHERE user_id = ? " +
          "ORDER BY created_at ASC, machine_id ASC LIMIT -1 OFFSET ?",
      ),
      /*
       * Every over-limit machine in the fleet, for a listing — so a route that
       * draws sixty rows is one query rather than sixty.
       *
       * The clamp is applied here as well, with the ceiling as the second
       * parameter, so this and `machineStanding` cannot disagree about a row
       * written by a release with a higher ceiling.
       */
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

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Whether a limit is this person's own or the instance's. */
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
  /** `rank >= limit`. Over the commercial limit. */
  over: boolean;
  /**
   * The owner is banned.
   *
   * **A second gate on the same row, and a different one from `over`.** Both
   * switch a machine off and both are reversible by an admin typing one thing,
   * which is why they live together — but they are refused with different codes
   * because the remedies are different, and a client that conflated them would
   * tell somebody to retire a machine when the answer is to unban a person.
   *
   * This closes a hole that had nothing to do with quotas: `relay/authorize.ts`
   * reads `disabled_at` for the **caller** (`activeUser(db, claims.sub)`) and
   * nothing anywhere read it for the *owner*. So banning somebody left every
   * machine they own working for anybody holding a grant, and left their daemons
   * holding tunnels — the ban stopped them signing in and stopped nothing else.
   *
   * Derived rather than written, for the reason the whole file gives, and here
   * the argument is sharper still: `disable` is the **reversible** remedy, so a
   * ban that revoked machines would make the undoable act undoable everywhere
   * except the part that matters most — a machine must be re-registered and
   * re-enrolled by hand on its host. Derived, `enable` brings the fleet back on
   * the daemon's own backoff with nobody touching anything.
   */
  ownerDisabled: boolean;
}

/**
 * The instance-wide default.
 *
 * **Unset resolves to `MAX_MACHINES_PER_USER`, and that is the load-bearing
 * choice in this file.** Nothing seeds `instance_settings`, deliberately, so on
 * an upgrade this setting is unset on every existing deployment. If unset meant
 * 0, the next deploy would take every machine in the fleet off the network — the
 * relay refusing every tunnel — with no operator having done anything. Unset
 * means *exactly the behaviour before this setting existed*, and 0 is a value
 * somebody chooses.
 */
export function instanceMachineLimit(db: DatabaseSync): number {
  return readInteger(db, "machines.per_user", MAX_MACHINES_PER_USER, 0, MAX_MACHINES_PER_USER);
}

/** This person's ceiling, and where the number came from. */
export function effectiveLimit(db: DatabaseSync, userId: string): EffectiveLimit {
  const instanceDefault = instanceMachineLimit(db);
  const row = statements(db).override.get(userId);
  if (row === undefined) return { limit: instanceDefault, source: "default", instanceDefault };
  return {
    // Clamped on read as well as refused on write: a row written by a release
    // with a higher ceiling must not out-rank the ceiling this one enforces.
    limit: Math.min(Number(row["max_machines"]), MAX_MACHINES_PER_USER),
    source: "user",
    instanceDefault,
  };
}

/** How many machines this person owns. The number the limit is enforced against. */
export function machineCount(db: DatabaseSync, userId: string): number {
  return Number(statements(db).count.get(userId)?.["n"] ?? 0);
}

/**
 * Where this machine stands with its owner, or `null` for one nobody owns.
 *
 * **`null` means allowed, and callers must treat it that way.** An ownerless
 * machine has no owner to have a limit: that is every machine registered before
 * `machine_owners` existed, every one an admin created without an `ownerId`, and
 * every one whose owner was deleted. The natural-looking `?.over ?? true` takes
 * all of them off the network on deploy.
 */
export function machineStanding(db: DatabaseSync, machineId: string): Standing | null {
  const row = statements(db).standing.get(machineId);
  if (row === undefined) return null;
  const override = row["override"];
  // The instance default is read only when there is an ownership row *and* no
  // override, so an ownerless machine and an overridden user both pay nothing
  // for it on the relay's per-request path.
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

/**
 * Every machine whose owner is banned, for a listing — the sibling of
 * `overLimitMachineIds`, and one query rather than one per row.
 */
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

/**
 * The suspended tail, oldest first — so the last entry is the one that went
 * first. Empty when they are within their limit.
 */
export function overLimitMachines(db: DatabaseSync, userId: string, limit: number): OverLimitMachine[] {
  return statements(db)
    .tail.all(userId, Math.max(0, limit))
    .map((row) => ({ id: String(row["machine_id"]), label: String(row["label"]) }));
}

/** Every over-limit machine in the fleet, so a listing route is not N+1. */
export function overLimitMachineIds(db: DatabaseSync): Set<string> {
  const rows = statements(db).fleet.all(instanceMachineLimit(db), MAX_MACHINES_PER_USER);
  return new Set(rows.map((row) => String(row["machine_id"])));
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export function writeMachineLimit(
  db: DatabaseSync,
  userId: string,
  maxMachines: number,
  updatedBy: string | null,
  now = Date.now(),
): void {
  statements(db).write.run(userId, maxMachines, now, updatedBy);
}

/** Drop the override. The instance default becomes their limit again. */
export function clearMachineLimit(db: DatabaseSync, userId: string): boolean {
  return Number(statements(db).clear.run(userId).changes) === 1;
}
