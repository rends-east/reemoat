import type { DatabaseSync } from "node:sqlite";
import { MAX_DAEMON_VERSION_CHARS } from "../../../src/relay/protocol.js";
import { newId } from "./keys.js";

/**
 * Machines that belong to somebody.
 *
 * A machine used to belong to nobody: an admin registered it, an admin minted its
 * enrollment code, and an admin granted somebody access to it. Three acts, none
 * implying the others, and the only record of who it was *for* was
 * `enrollment_codes.created_by` — written once and read by nothing.
 *
 * A user creates their own now, and the row in `machine_owners` is what makes
 * "this daemon is mine" a fact the system stores rather than a convention two
 * humans remember.
 */

/**
 * What a person may call their machine.
 *
 * No `/`, because the qualified name below is built by joining on one; no leading
 * or trailing space, for the same reason a user name has none. Everything else a
 * hostname would contain is allowed.
 */
export const MACHINE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The one label shape that is refused: something already shaped like a machine id.
 *
 * `newId("m")` is `m_` plus random bytes as hex, and `MACHINE_LABEL` allows
 * every character in that — a letter, then `_` and hex digits. So a label *can*
 * be spelled exactly like somebody else's machine id, and `resolveMachineRef`
 * resolved a caller's own label before it resolved an id. Labelling one of your
 * machines `m_1a2b3c4d` therefore made every `POST /v1/tokens {machine:
 * "m_1a2b3c4d"}` from the browser return a token whose `aud` is *your* machine
 * while the client believed it had asked for the other one — silently, since both
 * resolutions are legitimate and neither errors.
 *
 * Refused at the label rather than repaired at the lookup, because a name that
 * cannot be spelled like an id cannot collide with one at any call site, present
 * or future. `resolveMachineRef` is *also* reordered; see the note there for why
 * both, when either alone would do.
 *
 * ⚠ **Two lengths, and both are load-bearing.** `newId` mints eight bytes now and
 * minted four before, so 16 hex is what a fresh id looks like and 8 hex is what
 * every id already sitting in a database looks like. Refusing only the current
 * width would leave every *existing* machine's id spellable as somebody's label,
 * which is the original collision reintroduced against exactly the machines that
 * have been around longest. `relaycheck` generates real ids and asserts this
 * refuses all of them, which is how the widening of `newId` was caught here at
 * all rather than in production.
 *
 * Anchored and exact-length: it refuses only the two shapes an id actually has,
 * so `m_deadbeefcafe` and `m_1a2b3c4` stay ordinary names.
 */
export const MACHINE_LABEL_RESERVED = /^m_(?:[0-9a-f]{8}|[0-9a-f]{16})$/;

/**
 * The refusal sentence for a malformed label, said once.
 *
 * It was written out at four call sites in `app.ts` and had **already drifted
 * into two versions** — two of them dropped the "must start with a letter or
 * digit" clause while testing the identical regex, so the same request was
 * refused with two different explanations depending on which route it hit. A
 * sentence that describes a constant belongs beside the constant.
 */
export const MACHINE_LABEL_HELP =
  "name may contain letters, digits, and . _ - only, and must start with a letter or digit";

/** Why a well-formed name shaped like a machine id is still refused. See `MACHINE_LABEL_RESERVED`. */
// No digit count in the sentence, deliberately. `MACHINE_LABEL_RESERVED` matched one
// width, then two when `newId` widened, and this string still said "8" — a caller
// refused for a 16-hex label was told the rule was about 8. `relaycheck` asserts the
// 400's message *equals this constant*, so the assertion stayed green while the
// sentence was wrong. Naming the shape rather than the width is what stops that
// happening again the next time `newId` moves.
export const MACHINE_LABEL_RESERVED_HELP = "name may not be spelled like a machine id (m_ followed by hex digits)";

/**
 * Whether this is a name somebody may actually use.
 *
 * Both rules in one call, so a route cannot test the character rule and forget
 * the reserved shape — which is the whole failure `MACHINE_LABEL_RESERVED`
 * exists to close. The caller trims before calling: a label is stored as given
 * and `MACHINE_LABEL` allows no leading or trailing space.
 */
export function labelIsWellFormed(label: string): boolean {
  return MACHINE_LABEL.test(label) && !MACHINE_LABEL_RESERVED.test(label);
}

/**
 * The **ceiling** on how many machines one person may own — not the limit.
 *
 * Creating a machine is now reachable by anybody with a password, and each one is
 * a row plus an enrollment code plus a tunnel credential when it enrolls. Without a
 * cap, "users create their own machines" is "any user can grow this database",
 * against a file running `synchronous = FULL` in the process that carries every
 * tunnel. Fifty is far above what this product is for and far below a problem.
 *
 * **There are two bounds now and this is the anti-abuse one.** The other is
 * `machines.per_user` in `settings.ts`, overridable per person in
 * `user_machine_limits` and resolved by `quota.ts` — the commercial limit, which
 * an admin *raises to sell*. They are kept apart rather than collapsed because
 * collapsing them means an admin typing 500 for a customer has silently removed
 * the database-growth bound above, and that failure is not a refusal anybody
 * sees: it is a slow instance. So this value is refused on both write paths and
 * clamped again on read, and the configurable limit can only ever be lower.
 *
 * Unset, the configurable limit resolves to *this* number, which is what makes
 * deploying the setting a no-op on an instance that has not chosen one.
 */
export const MAX_MACHINES_PER_USER = 50;

/**
 * The name a row actually carries, which nobody is shown.
 *
 * `machines.name` is globally `UNIQUE` and cannot stop being — this package has
 * no `migrate()`, so the constraint is as permanent as the table. That is fine
 * for a name nobody chooses: appending the machine's own id makes a collision
 * impossible by construction, so the 409 that would otherwise tell one user that
 * *another* user has a machine called "laptop" is not a case that can arise.
 *
 * The pretty name lives in `machine_owners.label`, unique per owner, where a
 * collision is with your own machine and leaks nothing.
 */
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

/**
 * The machine this caller means, resolved the way a person would mean it.
 *
 * **The machine id is tried first, and that order is load-bearing.** It used to
 * be their own label first — reasonable, since a label is what they typed and
 * what the UI shows them — but `MACHINE_LABEL` admits the exact shape of an id,
 * so a label could shadow another machine's id and `POST /v1/tokens` would mint a
 * token for the wrong `aud` with nothing on either side reporting a problem. An
 * id is unambiguous and nobody's to choose, so nothing is lost by asking it first.
 *
 * Then the caller's own label, then `machines.name` — what a machine created
 * before ownership existed is still called, and what `cpctl admin machines`
 * prints. Deliberately **not** somebody else's label: the whole point of scoping
 * labels per owner is that two people may use the same word.
 *
 * `machines.name` is split out of the old combined `id = ? OR name = ?` because
 * that clause cannot express a precedence between the two, and a label sits
 * between them now.
 *
 * **Either this order or `MACHINE_LABEL_RESERVED` would close the shadowing on
 * its own, and both are here on purpose.** The refusal is the real fix; this
 * ordering is what means a future loosening of the label rule — a new allowed
 * character, a migration that backfills labels, an admin tool that writes one
 * directly — cannot quietly reopen it.
 */
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

/**
 * What to call a machine when showing it to the user the row was selected for.
 *
 * Their own label if they own it. Otherwise the row's real name — which for a
 * machine somebody else created is the qualified one, and for a legacy machine is
 * whatever an admin typed. Never another user's label: it is theirs, and two
 * people may hold a grant on one machine and call it different things.
 *
 * **Takes the two values rather than the database**, which is the shape that
 * makes it usable at all. It was previously a query keyed on `(machineId,
 * userId)` and was called from nowhere — every listing already `LEFT JOIN`s
 * `machine_owners` scoped to the caller, so re-asking per row would have been one
 * extra statement each to learn something the row in hand already says. The rule
 * was therefore inlined at the projections instead, in two places, which is one
 * rule with two homes and no way to keep them agreeing.
 *
 * `label` is `unknown` because it arrives straight off a `SQLite` row: `null`
 * from a `LEFT JOIN` that missed, and `undefined` if a caller projects a column
 * that is not there. Both mean "this caller does not own it", which is the safe
 * read — the wrong direction would print somebody's private label to a stranger.
 */
export function labelOrName(label: unknown, rowName: string): string {
  return label === null || label === undefined ? rowName : String(label);
}

export type CreateRefusal = "label_taken" | "too_many";

/**
 * Whether this error is the unique index refusing a duplicate.
 *
 * A string match against a driver's message, which is unpleasant and is the
 * signal that exists: `node:sqlite` throws a plain `Error` whose message carries
 * `UNIQUE constraint failed: …` and exposes no stable code to switch on. Named
 * once rather than written at each `catch`, so the two callers cannot come to
 * disagree about the spelling — and so the day a code *does* arrive, there is one
 * line to change.
 *
 * Deliberately narrow in what it claims: it says "a uniqueness constraint was
 * tripped", and each caller decides which of its own constraints that can only
 * have been.
 *
 * Exported for the third caller, `POST /v1/admin/users` in `app.ts`, which has
 * the same shape of race one table over: it reads `users.name` for a duplicate,
 * then awaits ~51ms of scrypt before inserting, so two overlapping creates of one
 * name both pass the read. The point of sharing this rather than writing the
 * match a third time is the spelling — the alternative was a route that answers
 * `500 text/plain` instead of the error envelope every client in this system
 * parses, which is what it did.
 */
export function isUniqueViolation(error: unknown): boolean {
  return String(error).includes("UNIQUE");
}

/**
 * Drop a machine's ownership row. Returns how many rows went (0 or 1).
 *
 * **Called inside the revoke transaction, because revoking without it leaks two
 * things that never come back.** `machine_owners` has no `revoked_at` and the
 * unique index on `(user_id, label)` does not join `machines`, so a revoked
 * machine keeps holding its label for ever: revoke `laptop`, create `laptop`
 * again, and the answer is `409` naming a machine that appears in no list and can
 * never be reached. `createOwnedMachine` counts the same table with no revoked
 * filter, so the row also keeps consuming one of `MAX_MACHINES_PER_USER` —
 * fifty revocations and the account cannot add another machine at all, with
 * nothing on screen to explain it.
 *
 * So what this frees is exactly those two: **the label, and the quota slot.**
 *
 * It frees a third thing now, for free and without a line of code here:
 * a **rank**. `quota.ts` decides which of somebody's machines are switched off
 * by position among the rows in this table, so deleting one decrements every
 * later rank — revoke machine #2 of five under a limit of three and #4 starts
 * working on the next request. That is the derived design paying for itself, and
 * it is the assertion worth keeping in `relaycheck`.
 *
 * The `machines` row itself is untouched and stays revoked — the audit trail of
 * which machines existed is in that table, not this one, and a `DELETE` here
 * matches what deleting the *owner* already does (`machine_owners` goes, the
 * machine survives ownerless). A machine with no owner row is not a state to
 * invent: it is what every machine registered before ownership existed already
 * is.
 */
export function releaseOwner(db: DatabaseSync, machineId: string): number {
  return Number(db.prepare("DELETE FROM machine_owners WHERE machine_id = ?").run(machineId).changes);
}

/**
 * Whether this caller can already see a machine by this name.
 *
 * **Wider than the unique index, and the difference is the bug it closes.** The
 * index scopes a label to its owner, which is what lets two people each have a
 * "laptop". It says nothing about a machine somebody *shared* with you, or one an
 * admin registered before ownership existed — and those appear in your list under
 * `machines.name`. So a person with a legacy machine called `mac` could create
 * their own `mac` and end up with two rows reading `mac`, indistinguishable, with
 * `POST /v1/tokens {machine:"mac"}` silently resolving to whichever
 * `resolveMachineRef` reaches first.
 *
 * Measured before this existed, reproducing a real deployment: `ada` saw
 * `mac(owned=false), mac(owned=true)` and her own label shadowed the machine she
 * had actually been using.
 *
 * Refusing leaks nothing: every name compared here is one this caller is already
 * being shown.
 */
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
    // The same projection the listing route draws — through `labelOrName`, so
    // "what is this machine called to me" has one home rather than a copy here.
    const shown = labelOrName(row["label"], String(row["name"]));
    return shown.toLowerCase() === label.toLowerCase();
  });
}

/**
 * The same question asked from the other side: would this row name shadow
 * something for one of the people it will actually be shown to?
 *
 * `nameVisibleTo` takes the user, because every other naming path knows who is
 * being handed the name — a creator, or the owner an admin is registering for.
 * `PATCH /v1/admin/machines/:id` writes `machines.name`, which is not one
 * person's name for the machine: it is the name **everybody holding a grant on
 * it who does not own it** reads in their list, via `labelOrName`. So the
 * audience has to be enumerated rather than passed in, and that is the whole
 * difference between this and the function above.
 *
 * **The owner, where there is one, is deliberately not asked.** `labelOrName`
 * hands them `machine_owners.label`, so this write is invisible to them — and
 * asking anyway would refuse an admin a rename over a collision the owner can
 * never see, which is a refusal nothing on screen could explain.
 *
 * **A machine with no owner row is asked about every grantee**, and that is this
 * rule read with an empty exception rather than a case of its own: nobody is
 * shown a label for it, so `machines.name` is what all of them see. It is also
 * the case that makes this guard worth having — a legacy row is the one whose
 * `machines.name` an admin has any reason to type, and `cpctl admin setmachine
 * <id> --name <n>` is the documented way to do it.
 *
 * Case-folded, because `nameVisibleTo` is: the `machines.name` unique index is
 * BINARY, so `LAPTOP` beside `laptop` is the same indistinguishable pair and
 * only this check sees it.
 *
 * ---
 *
 * **This is the last door that gives a machine a *name*. It is not the last door
 * that makes a name visible, and `PUT /v1/admin/grants` is knowingly open.**
 *
 * Written down because the difference is easy to lose: the five guarded routes
 * all *write* a label or a name, and a grant writes neither — it hands somebody a
 * machine that is already called something. The state it can reach is the same
 * one. ada owns a machine she labelled `laptop`; an admin grants her an ownerless
 * legacy row whose `machines.name` is `laptop`; her list now draws two
 * indistinguishable `laptop` rows through `labelOrName`, and `resolveMachineRef`
 * probes id, then her own label, then `machines.name` — first hit wins — so
 * `POST /v1/tokens {machine: "laptop"}` resolves to her own for the life of the
 * grant and the granted machine is unreachable by name.
 *
 * Not an escalation: `POST /v1/tokens` still checks the grant after resolving, so
 * this costs reachability rather than authority. It is left open because the
 * remedy is not obviously right — refusing the grant would refuse an admin a
 * share over a collision only the grantee can see, on the one route `cpctl admin
 * grant` drives and the only remaining way to share a machine at all. The honest
 * state is a sentence here rather than a guard nobody weighed, which is the
 * `sessionOf` rule read the way round it is usually needed: say what is not
 * covered, so the next reader does not infer coverage from the four checks above.
 */
export function nameVisibleToGrantees(db: DatabaseSync, machineId: string, name: string): boolean {
  const owner = ownerOf(db, machineId);
  const grantees = db.prepare("SELECT user_id FROM grants WHERE machine_id = ?").all(machineId);
  return grantees.some((row) => {
    const userId = String(row["user_id"]);
    if (owner !== null && userId === owner.userId) return false;
    return nameVisibleTo(db, userId, name, machineId);
  });
}

/**
 * Register a machine to a user, and grant it to them, in one transaction.
 *
 * The grant is not a separate act any more. It used to be — `addmachine` then
 * `grant`, printed as a hint by two wizards and run by neither — and the gap
 * between them is where every "the daemon enrolled and nobody can see it" report
 * came from.
 *
 * The label uniqueness is enforced by the unique index rather than by a read
 * before the write, so two requests racing cannot both pass it.
 *
 * **`limit` is required and has no default**, which is `burnUserCodes`' rule for
 * its `reason`: a default makes the wrong call the easy one to write, and this
 * one decides whether somebody may have a machine at all. Required, every call
 * site is a compile error until it says which limit it means.
 *
 * It arrives as a *number* rather than being read here, so this module stays a
 * leaf: `quota.ts` imports `settings.ts` which imports this file, and resolving
 * the limit here would close that ring. The ceiling is re-applied below anyway,
 * so a caller that computes the limit wrongly cannot get past fifty — this is
 * the only INSERT into `machine_owners` outside the admin's adoption route, and
 * therefore the one place "never more than fifty" can be true by construction.
 */
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
  // Both bounds at once: the commercial limit the caller resolved, and the
  // anti-abuse ceiling this file owns.
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
    /*
     * Every scope, not the two `cpctl admin grant` defaults.
     *
     * `machine:admin` is what guards `DELETE /sessions/:id/workspace` on the
     * daemon, so a grant without it means the owner of a machine cannot remove a
     * workspace on it — a 403 from the phone, on their own hardware, for a
     * reason nothing on screen could explain.
     */
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      userId,
      id,
      scopes.join(" "),
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    // The unique index on (user_id, label) is the only constraint a caller can
    // trip here; `machines.name` cannot collide by construction and the id is
    // fresh. Reported as the caller's own duplicate rather than as a 500.
    if (isUniqueViolation(error)) return { error: "label_taken" };
    throw error;
  }

  return { id, name };
}

/**
 * Rename a machine you own. The row's `machines.name` is untouched — see `qualifiedName`.
 *
 * **`user_id` is in the `WHERE` clause and is not decoration.** The `UPDATE` used
 * to key on `machine_id` alone and rely entirely on the route having resolved
 * ownership two statements earlier — correct today, and a function that rewrites
 * a row somebody else owns whenever it is called with the wrong argument. There
 * is one call site and nothing about it says so at the point the SQL runs. With
 * the clause, the statement is safe read on its own: a caller who is not the
 * owner changes nothing rather than renaming a stranger's machine.
 *
 * It costs the ability to distinguish "not yours" from "no such machine", which
 * is not a distinction this should be drawing anyway — the route answers 404 for
 * both, and `ownerOf` upstream is what decides.
 */
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

/* ------------------------------------------------------------------ *
 * What build is on the other end
 * ------------------------------------------------------------------ */

/**
 * A daemon's self-reported build, cleaned up enough to store.
 *
 * The value is a **label supplied by the far end** and is treated as one: it is
 * never parsed, compared, ordered or branched on, so there is no format to
 * enforce and nothing is refused for having the wrong shape. What it gets is a
 * length bound and a character filter, for the ordinary reason any
 * caller-supplied string that will later be printed on a screen gets them.
 *
 * `null` for absent or empty, which is what a daemon predating the header sends,
 * and which reads as "did not say" rather than as a version.
 */
export function readDaemonVersionHeader(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  // Printable ASCII only. A version string is one; anything else arrived from a
  // client that is not this daemon, and a control character would land in a log
  // line and an admin table.
  const cleaned = value.trim().replace(/[^\x20-\x7e]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_DAEMON_VERSION_CHARS);
}

export interface DaemonBuild {
  daemonVersion: string | null;
  protocolVersion: number;
  at: number;
}

/**
 * Record what dialled in, against the machine that dialled.
 *
 * On `machines` rather than on `relay_tunnels`, and the difference is what
 * survives a disconnect. A tunnel row is deleted when the tunnel goes and swept
 * when a relay restarts, so a fleet inventory built on it can only ever describe
 * what is online *now* — and the machine a staged rollout most needs to know
 * about is the one that has been offline for a month on a version nothing else
 * still speaks. The columns are added by `migrate()` and are nullable, so a
 * machine that has never dialled since this shipped simply says nothing.
 *
 * Best-effort by contract. Every caller is on the tunnel-dial path, where the
 * failure this must not cause is a refused tunnel; a lost row costs one stale
 * answer to a question nobody is blocked on.
 */
export function recordDaemonBuild(db: DatabaseSync, machineId: string, build: DaemonBuild): void {
  try {
    db.prepare(
      "UPDATE machines SET daemon_version = ?, daemon_protocol = ?, daemon_seen_at = ? WHERE id = ?",
    ).run(build.daemonVersion, build.protocolVersion, build.at, machineId);
  } catch {
    // Reporting, not deciding. See the docblock: a tunnel must not fail for this.
  }
}
