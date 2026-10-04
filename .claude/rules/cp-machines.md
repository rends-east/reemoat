---
paths:
  - packages/control-plane/src/machines.ts
  - packages/control-plane/src/quota.ts
  - packages/control-plane/src/permissions.ts
  - packages/web/src/quota.ts
  - packages/web/src/enrollment.ts
  - packages/web/src/ui/settings/MachinesSection.tsx
  - packages/web/src/ui/settings/MachineSection.tsx
---

## Ownership and names

**A machine belongs to whoever created it**: `POST /v1/machines` registers it, grants it
to its creator with every scope and mints its enrollment code in one request. Q1.500. A
label may not be spelled like a machine id (`MACHINE_LABEL_RESERVED`, tested by
`labelIsWellFormed`, the one call checking both rules), or `POST /v1/tokens` would mint
for the wrong `aud` silently.

**Every path that names a machine asks whether the name is already *visible* to its
audience.** `nameVisibleTo` on `POST /v1/machines`, `PATCH /v1/machines/:id`,
`PUT /v1/admin/machines/:id/owner` and the `ownerId` branch of `POST /v1/admin/machines`;
`nameVisibleToGrantees` (every grantee) on `PATCH /v1/admin/machines/:id`, since a legacy
row has no single owner. The BINARY unique index on `(user_id, label)` sees neither
grants nor legacy `machines.name`, so it is never the check; a duplicate makes
`resolveMachineRef` pick one silently. Q1.48. **`PUT /v1/machines/:id/grants` reaches a
collision without naming anything and is knowingly open**: it costs reachability, not
authority (`POST /v1/tokens` still checks the grant), and refusing would refuse a share
over a collision only the grantee can see. Q1.501.

**Sharing is the owner's verb.** The admin's `PUT`/`DELETE /v1/admin/grants` are
deleted (an admin credential one request from code execution on somebody's computer).
`PUT`/`DELETE /v1/machines/:id/grants` resolve through `ownedMachine`, refuse the owner's
own grant, and take a **user id** (no directory; a name lookup is an existence oracle).
`GET /v1/admin/grants` is kept. **`INSERT INTO grants` appears in exactly three places**;
no route under `/v1/admin` adds or widens a grant on an owned machine. **A share has an
exit**, since it is written without asking: `DELETE /v1/machines/:id/grants/me`, own
grant only, no `userId` parameter, `409 grant_is_owner` on your own machine, one
`404 grant_not_found` for no grant and no machine. Shares received are unbounded:
`GET /v1/machines` has **no `LIMIT`** over `grants`, and the client opens a connection and
mints a token per row, all on the per-account write throttle.

**Ownership is releasable and reassignable, never away from a live owner.** Revoking
drops the `machine_owners` row in the same transaction (`releaseOwner`), returning the
label and one of `MAX_MACHINES_PER_USER`. `PUT /v1/admin/machines/:id/owner` writes the
grant with the ownership row (`createOwnedMachine`'s reason), leaves the previous
owner's grant, adopts **legacy** ownerless rows, refuses `403 machine_owned` for another
owner, and **burns the machine's outstanding codes** (the gates protect minting, not
redemption). Q1.43. **Both gates read `dependants()`** — owner **or** any grant — since
an ownerless legacy machine can be enrolled and carry grants: adopting a granted row is
`403 machine_granted` unless the target is a grantee (the only way back for them). An
orphan (enrolled, no owner, no grants) is the operator's.

**Admin guards on state an admin can manufacture**: `DELETE /v1/admin/users/:id` revokes
an ownerless enrolled machine whose last grantee it removes (only rows that account was
on). `POST /v1/admin/machines/:id/enrollments` refuses `409 code_outstanding` over a
live code somebody else minted (minting supersedes, killing the owner's install), and
`409 machine_enrolled` for a machine enrolled **and** owned: redemption calls
`issueTunnelKey` and replaces the running daemon. Carve-outs: the wizard (a row with no
code, created a line earlier), an admin re-minting their own, a legacy row with nobody to
ask. The owner's own route may re-mint.

**Substitution is made visible, not refused** (every step is a route that must stay):
`GET /v1/machines` carries **`enrolledBy`**, whoever's code brought the machine online
when not the reader, drawn on the machine row and printed by `cpctl machines`. Keeping
the label on revoke or teaching `nameVisibleTo` about revoked rows would each restore a
fixed bug. **It is read off `machines.enrolled_by`, written at redemption; never derive
it from `enrollment_codes`** (swept after seven days, `created_by` dangles,
`POST /v1/provision` writes a `pk_` id, `used_at` is also stamped by four burns — all answering
`null`, "you enrolled this"). Limit: the wizard enrolls on an **admin's** code, so it is
a name to recognise, not an alarm; re-enrolling yourself resets it.

**No non-revoked machine is ownerless**: `DELETE /v1/admin/users/:id` revokes their
machines (`machinesRevoked`) and `ownerId` is required on `POST /v1/admin/machines`.
Revoked ownerless rows are inert. **Legacy rows are the residue**: working, visible
(`owner: null`, `no owner` in `cpctl admin machines`), adopted with `PUT …/owner`. Q7.95,
reversed.

## The limit

**`machine_owners.created_at` is when this user *acquired* the machine, and it decides
which machine dies.** `PUT …/owner` writes a fresh one on a transfer and **preserves it
when the owner is unchanged** (the admin's only re-label), and its count excludes
`machine_id != ?`. Q1.51.

**Two bounds kept apart**: `MAX_MACHINES_PER_USER` is the anti-abuse **ceiling**;
`machines.per_user` (a setting, overridable per person in `user_machine_limits`) is the
commercial **limit**, refused above the ceiling on both write paths and clamped on read.
**Over the limit is derived, never stored**: a machine is over iff its rank by
`(machine_owners.created_at, machine_id)` is `>= effectiveLimit(owner)`. Lowering
switches off the newest, raising restores them, `releaseOwner` promotes the next. The
`machine_id` tiebreak matters (same-millisecond acquisitions); ordering by last
connection oscillates. Q1.51.

**Unset means 50**, the deploy-safety property: nothing seeds `instance_settings`, and a
0 default would take the fleet offline on deploy. Choosing 0 closes an instance; the UI
then offers no way to add a machine, only a sentence to ask the operator.

**Enforced on every path creating or reaching a machine** (count not written down,
Q1.502). `POST /v1/machines`, `POST /v1/provision`, `POST /v1/admin/machines`,
`PUT /v1/admin/machines/:id/owner` refuse creation with `409 machine_limit`;
`POST /v1/machines/:id/enrollments`, `POST /v1/tokens`, `relay/authorize.ts` and
`relay/tunnel-endpoint.ts` refuse an over-limit machine with `403 machine_over_limit`,
the last two **after** the grant is proved (else a probe for any `aud`). **The tunnel is
refused at dial**, so the row reads `relayOnline: false` plus `overLimit: true`; the
daemon's 1s→30s backoff recovers it. Q1.51.

**Banning switches machines off, reversibly**: `quota.ts` carries `ownerDisabled`; the
relay, the dial and `POST /v1/tokens` refuse `403 owner_disabled` — **not**
`user_disabled`, which would sign a grantee out. Derived, since `disable` is reversible.
Two codes because the remedies differ; the badge shows the ban first. Q1.52.

## Adding a daemon for somebody else

**The fleet provisioning key, not an admin key.** `POST /v1/provision` takes a `pk_` and
does three things: creates the machine owned by a named user, raises their limit to
`owned + 1` if needed (a **visible override**), mints the ordinary code. Nothing else.
**Machine first, limit only once it exists**, so a refused provision changes nothing;
`machineLimitRaisedTo` rides only the 201. Q1.503. **A name resolves to one account or
`409 user_ambiguous`** (`users.name` BINARY, `idx_users_name_folded` plain). Q1.504.
**The daemon never sees the key**: the installer (`install.sh`, `cpctl provision`)
trades it for a code; `enroll.ts` is untouched. Above THE LINE with its own throttle
namespace. **One key, minting the only verb** (`POST` retires the previous in the same
transaction; no revoke, no off); **nothing draws it**, the read answering
`{minted: boolean}`. **It lives where you provision from, never on the provisioned host**
(`agentEnv`'s strip is hygiene). Reuse is kept; the threat is inserting the holder's own
machine into somebody's list. Q1.53.

## The one-line installer

**Three copies of `shellQuote`, one on a route**: `packages/web/src/enrollment.ts` (the
`export` lines and `installCommand`), `cpctl.ts`'s `enrollmentLines`, and `app.ts`'s for
`GET /install.sh`, where the value is `publicUrl(c)`, the caller's `Host` — unquoted, RCE
for anyone piping it into `sh`. None can import another, so **`webcheck` reads all three
off disk and runs them over one hostile table**; extraction takes `function <name>(` at
column 0 to the next column-0 `}`, and nesting, renaming or an unstrippable annotation
makes it **throw**. A fourth copy must join it.

**`installCommand` takes the page's origin, never a constant** (`packages/web/src/cp.ts`
has no base URL), so a self-hosted instance prints a command joining itself. **It is the
only way to add a machine from the app** (the by-name form is gone; `cpctl enroll` still
mints a code). Drawn in three places — the rail's empty state below `lg`,
`NothingSelected` at `lg`, Settings → Machines — **inside the `mayAddMachine` arm on all
three**, keeping `machineQuotaNotice` `null`-iff the door is drawn; **not** in
`NewSession.tsx`'s `MachineLine`. `webcheck` asserts placements and the form's absence.
`store.ts`'s poll re-lists an empty fleet every tick and re-reads `me` when the first
machine lands.

**No link to rent a machine; a deletion, not an unset default** (Q1.650):
`webcheck.shell-and-enrollment.ts` asserts its names are gone, `deploycheck` that
`main.ts` no longer reads `REEMOAT_CP_MACHINES_OFFER_URL`. Bringing it back starts at
Q1.632: inside the `mayAddMachine` arm, below the command.

## Links between one owner's machines

**A link is the owner's verb, not a grant.** `POST /v1/machines/:id/links` resolves `:id`
as `POST /v1/tokens` does, requires ownership (a grantee gets 404), and answers a link per
other owned machine that is enrolled, keyed, live, granted and within the limit — finding
or writing the live `machine_links` row and minting a fresh capability each call: `aud`
the target, `sub` the owner, `LINK_SCOPE` only, `cnf.jkt` the **source's** key from
`machineKeyFor`, never the request. It lives `LINK_TOKEN_TTL_SECONDS`; revocation is the
relay reading the row. No single link is removable: switching a machine off or isolating
it revokes every link it is on in the same write, and switching back mints new ids
(Q1.654, Q3.676). No link path writes `grants`; `LINK_SCOPE` never enters `ALL_SCOPES`.
Q1.652.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/enrollment.ts` | The daemon's three start lines and `installCommand`, as shell **data** (`controlPlaneUrl` from the request's `Host`; a backtick survives `URL.origin`) |
| `packages/web/src/quota.ts` | `mayAddMachine` reads `canAddMachine` and **fails open** on absence; `webcheck` pins notice `null` **iff** the door is drawn. `machineLimitProblem` (both admin screens), `machineLimitChangeNotice` (non-`null` **is** the decision to confirm a lowering) |
| `packages/control-plane/src/machines.ts` | Label rules, create-plus-grant in one transaction, `releaseOwner`, `isUniqueViolation`, `MAX_MACHINES_PER_USER` (the limit lives elsewhere). `createOwnedMachine` takes the limit as a **required** argument |
| `packages/control-plane/src/quota.ts` | **The rank rule alone**, one statement with its own cache, plus the clamp for rows a looser release wrote. `null` from `machineStanding` means *unowned* and must read as allowed: `?.over ?? true` takes every pre-ownership machine offline |
| `packages/control-plane/src/permissions.ts` | Whether agent messaging is on per account and machine (no row is on); `nextPolicyAt` only grows; `messagingOffMachineIds` is what a mint leaves out. Q1.654 |

## Bounds

| | |
|---|---|
| Grants listing | 500 per page, 2000 max, with a `total` |
| Machines per user | **Ceiling 50; limit `machines.per_user`**, unset = 50. **One live enrollment code each** (minting burns the previous). The count is `machine_owners` rows with **no revoked filter**, so a revoke must `releaseOwner`; `PUT …/owner` counts *other* machines |
