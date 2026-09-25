---
paths:
  - packages/control-plane/src/machines.ts
  - packages/control-plane/src/quota.ts
  - packages/web/src/quota.ts
  - packages/web/src/enrollment.ts
  - packages/web/src/ui/settings/MachinesSection.tsx
  - packages/web/src/ui/settings/MachineSection.tsx
---

**A machine belongs to whoever created it.** `POST /v1/machines` registers it,
grants it to its creator with every scope and mints its enrollment code in one
request. Q1.500. A label may not be spelled like a machine id —
`MACHINE_LABEL_RESERVED`, tested by `labelIsWellFormed`, the one call that cannot
check one rule and forget the other — because `MACHINE_LABEL` admits that shape
and `POST /v1/tokens` would then mint for the wrong `aud` with nothing on either
side reporting it.

**Every path that gives a machine a name asks whether that name is already
*visible* to its audience, and there are five of them.** `nameVisibleTo` on `POST
/v1/machines`, `PATCH /v1/machines/:id`, `PUT /v1/admin/machines/:id/owner` and
the `ownerId` branch of `POST /v1/admin/machines`; `nameVisibleToGrantees`, the
same question asked of *every* grantee, on `PATCH /v1/admin/machines/:id`,
because a legacy row has no single owner to ask about. The unique index on
`(user_id, label)` is BINARY and sees neither a grant nor a legacy
`machines.name`, so it is never the check; what a duplicate costs is
`resolveMachineRef` silently picking one and leaving the other unreachable by
name. Q1.48.

**`PUT /v1/machines/:id/grants` is a sixth path that reaches the same state
without naming anything, and it is knowingly open.** A grant hands somebody a
machine already called something, so the collision arrives with no write to a
label and no check on the way. It costs reachability rather than authority, `POST
/v1/tokens` still checking the grant after resolving. The reasoning is unchanged
by the move off `PUT /v1/admin/grants`: refusing would refuse a share over a
collision only the *grantee* can see, which the sharer cannot see either. Q1.501.

**Sharing is the owner's verb, and the admin's two writes are deleted.** `PUT`
and `DELETE /v1/admin/grants` upserted any `{userId, machineId}` on
`requireAdmin` alone; a grant is full access to a machine that runs agents as its
owner with no sandbox, so the pair was one request from an admin credential to
code execution on somebody's computer. `PUT`/`DELETE /v1/machines/:id/grants`
resolve through `ownedMachine`, refuse the owner's own grant on both verbs, and
address the other person by **user id** — there is no directory an ordinary
account may read, and a name lookup would be an account-existence oracle. `GET
/v1/admin/grants` is kept: the read is not the power that was removed.
**`INSERT INTO grants` appears in exactly three places**, and the invariant is
that *no route under `/v1/admin` adds or widens a grant on a machine that already
has an owner*.

**A share is written without asking, so it has an exit.** `PUT` takes any
`userId`, writes a permanent row and never consults the person named — and all
three verbs above resolve through ownership, so the grantee could reach none of
them. `DELETE /v1/machines/:id/grants/me` is theirs: their own grant only, no
`userId` parameter (the caller *is* the subject, and a route taking an id would be
`DELETE /v1/admin/grants` under another name), `409 grant_is_owner` on a machine
they own, and the same `404 grant_not_found` for both "no such grant" and "no such
machine". ⚠ **What the listing costs the recipient is why this is not cosmetic**:
`GET /v1/machines` selects from `grants` with **no `LIMIT`** — the ceiling is over
`machine_owners`, so nothing bounds shares *received* — the client builds a
connection per row and mints a token for each on resume, and those tokens are
counted against the same per-account write throttle as everything else.

**Two admin guards key on state an admin can manufacture, and both are closed at
the route that made it.** `dependants()` reads live `grants`, so deleting the last
grantee of an ownerless enrolled machine turned it into a "genuinely orphan row" —
adoptable with every scope. `DELETE /v1/admin/users/:id` now revokes such a machine
rather than leaving it, scoped to rows that account was actually on. And `POST
/v1/admin/machines/:id/enrollments` refuses `409 code_outstanding` over a live code
somebody else minted: minting supersedes, so on an owned-but-not-yet-enrolled
machine it silently killed the owner's in-flight install, repeatably, because
`enrolled_at` never left NULL for the `machine_enrolled` guard to catch. The
carve-outs are the wizard (a row with no code) and an admin re-minting their own.

**Ownership is releasable and reassignable, but never away from a live owner.**
Revoking drops the `machine_owners` row in the same transaction (`releaseOwner`),
giving back the label and one of `MAX_MACHINES_PER_USER`. `PUT
/v1/admin/machines/:id/owner` is the way back: it writes the grant with the
ownership row for `createOwnedMachine`'s reason, leaves the previous owner's
grant alone — ownership and access are different verbs — and is how a **legacy**
ownerless machine gets under the two gates below. It now refuses `403
machine_owned` when the machine has an owner other than the target, so what it
adopts is an ownerless row and what it re-labels is a machine for the owner it
already has. Adopting also **burns that machine's outstanding enrollment codes**,
because the gate below protects minting and not redemption: a code kept from
before an adoption otherwise still returns a tunnel key afterwards, so the machine
acquires an owner and is then replaced under them. Q1.43.

**Ownerless does not mean nobody depends on it, and both gates were keyed on the
wrong thing.** A machine registered before ownership existed can be enrolled,
online and carrying other people's grants — the state `nameVisibleToGrantees` is
written for. Keyed on `ownerOf` alone, an admin could adopt such a row with every
scope, or mint a code and re-enroll it out from under its grantees, and both
answered 200. Both read `dependants()` now — owner **or** any grant — and adoption
of a granted ownerless row is refused `403 machine_granted` unless the target is
one of those grantees. That exception is not a hole: handing the row to somebody
already on it is what regularises legacy data, and it is also the only route back
for those grantees, since deleting the admin grant writes left them with no way to
list, re-scope or revoke a share. An orphan row — enrolled, no owner, no grants —
has nobody to ask and stays the operator's.

**An admin may not mint an enrollment code for a machine that is enrolled *and*
owned** (`409 machine_enrolled`). Redeeming one calls `issueTunnelKey`, which
retires the running daemon's credential — so it does not read somebody's machine,
it replaces it, and every grant-holder's traffic lands in the new process while
the owner's list still reads owned and online. The owner's twin route allows
exactly this and justifies it by *only the owner can ask*; that sentence does not
transfer. Owned is the condition rather than enrolled alone, so `install.sh`'s
wizard (a row created one line earlier) and a legacy row with nobody to ask both
still work.

**What no refusal closes is machine *substitution*, so it is made visible
instead.** Revoke somebody's machine, register a new one for them under the name
`releaseOwner` just freed, mint its first code and redeem it on your own
hardware: their list draws the name they lost, owned and online, and it is your
computer. Every step is a route that has to stay — revoking is the denial side,
and registering a machine for somebody is what the installer's wizard does. Both
obvious refusals restore a fixed bug: keeping the label on revoke brings back "a
409 naming a machine that appears in no list", and teaching `nameVisibleTo` about
revoked rows refuses the owner their own recreate. So `GET /v1/machines` carries
**`enrolledBy`**, naming whoever's code brought the machine online when that was
not the reader — drawn on the machine row and printed by `cpctl machines`, since a
disclosure only a `curl` reader sees is not one.

**It is read off `machines.enrolled_by`, written at the redemption it describes,
and deriving it from `enrollment_codes` instead is the thing not to go back to.**
That spelling shipped first and was wrong four ways, every one of them answering
`null` — which the route reports as *you enrolled this yourself*. The sweep takes
the row after seven days; `created_by` is left dangling by design when an account
is deleted, so an inner join lost it with the account; `POST /v1/provision` writes
a `pk_` id no user matches; and `used_at` is stamped by four burn paths as well as
by redemption, so the owner minting a replacement code twice overwrote the name
with their own. It also scanned the fleet's whole code history per request on a
route polled every four seconds. ⚠ What survives all that is the field's real
limit: the installer's wizard enrolls on an **admin's** code, so every
wizard-installed machine names an admin and a substitution draws the same row as a
normal install. It is a name to recognise, not an alarm; re-enrolling the machine
yourself sets it back to you.

**`created_at` on that row is when this user *acquired* the machine, and it
decides which machine dies.** That route writes a fresh one on a transfer and
**preserves it when the owner is unchanged**, because it is also the admin's only
re-label — likewise why its own count excludes `machine_id != ?`. Q1.51.

**How many machines somebody may run is two bounds kept apart.**
`MAX_MACHINES_PER_USER` is the anti-abuse **ceiling**; `machines.per_user` — a
setting, env-seeded and database-owned, overridable per person in
`user_machine_limits` — is the commercial **limit** an admin raises to sell. The
limit is refused above the ceiling on both write paths and clamped again on read.
Q1.51.

**Being over the limit is derived, never stored.** A machine is over iff its rank
among its owner's machines — ordered by `(machine_owners.created_at, machine_id)`
— is `>= effectiveLimit(owner)`, so lowering switches off the ones acquired most
recently, raising switches them back on with nothing to recompute, and
`releaseOwner` deleting a row promotes the next by itself. The tiebreak on
`machine_id` is not tidiness: `created_at` is `Date.now()`, two machines acquired
in the same millisecond are reachable from a script, and without it an account
with a limit of 1 keeps two working machines. Ordering by *last connection*
oscillates — the suspended machine cannot connect, so its last-connect stays old,
so it becomes the oldest and un-suspends, on every poll. Q1.51.

**Unset means 50, and that is the deploy-safety property rather than a default.**
Nothing seeds `instance_settings`, so the setting is unset on every existing
instance and a 0 default would take every machine in the fleet off the network on
the next deploy with nobody having acted; unset is *exactly the behaviour before
the setting existed*. Choosing 0 is how an instance is closed, and the UI then
offers no way to add a machine anywhere, only a sentence saying to ask whoever
runs the control plane.

**It is enforced on every path that creates a machine and on every path that
reaches an existing one, and checked last on two of those.** The count is
deliberately not written here (Q1.502). `POST /v1/machines`, `POST
/v1/provision`, `POST /v1/admin/machines` and `PUT /v1/admin/machines/:id/owner`
refuse a creation with `409 machine_limit`; `POST /v1/machines/:id/enrollments`,
`POST /v1/tokens`, `relay/authorize.ts` and `relay/tunnel-endpoint.ts` refuse an
existing over-limit machine with `403 machine_over_limit`. The last two evaluate
quota **after** the grant is proved — asked earlier, any valid token becomes a
probe for whether an arbitrary `aud` exists and is over somebody's limit. **The
tunnel is refused at dial too**, unlike a revoked machine's already-open
one, so the machine reads `relayOnline: false` plus `overLimit: true` rather than
online and answering 403 to everything; the daemon's 1s→30s backoff is the
recovery path. Q1.51.

**Adding a daemon for somebody else is the fleet provisioning key, and it is not
an admin key.** `POST /v1/provision` takes a `pk_` and does exactly three things:
create the machine owned by a named user, raise that user's limit to `owned + 1`
if it would not fit (a **visible override**), and mint the ordinary single-use
enrollment code. It revokes, renames, grants and reads nothing. **The order is
the machine first and the limit only once it exists**, so a refused provision
changes nothing — `machineLimitRaisedTo` only rides the 201. Q1.503. **A name
resolves to exactly one account or is refused** (`409 user_ambiguous`), because
`users.name` is compared BINARY while `idx_users_name_folded` is a plain index
and `Casey` and `casey` can both exist. Q1.504. **The daemon never sees the
key**, forced by "a daemon makes exactly one control-plane request, ever":
provisioning is the *installer's* act, `install.sh` or `cpctl provision` trading
the key for a code, and `enroll.ts` is untouched. It sits above THE LINE because
`callerAuth` would refuse a credential that is not a person's, with its own
throttle namespace for the reason `/v1/enroll` has one. **One key,
and minting is the only verb** — `POST` retires the previous row in the
transaction that inserts the new one, with no revoke and no "off" — and **nothing
draws it or any part of it**, the read answering `{minted: boolean}` rather than
a value, a prefix or an id.
⚠ **It lives where you provision *from*, never on the host being provisioned**:
that host runs agents as its owner and `agentEnv`'s strip is hygiene rather than
a fence. What travels to a host is the enrollment code, single-use and one hour.
Reuse is kept rather than made single-use, and the threat is not reading
anybody's work but inserting a machine of the *holder's own* into somebody's
list, after which they may run agents on the holder's host. Q1.53.

**Banning somebody switches their machines off, reversibly.** `quota.ts` carries
`ownerDisabled` on the row it already reads, and the relay, the dial and `POST
/v1/tokens` all refuse on it with `403 owner_disabled` — **not** `user_disabled`,
which means *you* are banned and ends the client's session, so reusing it signs a
perfectly good grantee out of the app for opening somebody else's suspended
machine. Derived rather than revoked because `disable` is the reversible remedy
and re-enrolling a machine is a trip to its host. Two codes because the
**remedies differ** — retiring a machine does nothing for one whose owner is
banned — which is also why the badge orders the ban first. Q1.52.

**No non-revoked machine is ownerless**, both gates above being facts about the
*owner*: `DELETE /v1/admin/users/:id` revokes their machines (reporting
`machinesRevoked`) and `ownerId` is required on `POST /v1/admin/machines`.
Ownerless rows still exist and must — every revoke makes one — but those are
revoked and inert. **Legacy rows are the residue**: a machine predating
`machine_owners` keeps working, is visible (`owner: null`, `no owner` in `cpctl
admin machines`), and is adopted with `PUT /v1/admin/machines/:id/owner`, which
is what puts it under both gates. Q7.95, which this reverses.

**There are three copies of `shellQuote` now, and one of them is on a route.**
`packages/web/src/enrollment.ts` renders the three `export` lines *and*
`installCommand`, the one-liner the empty-fleet screens print;
`packages/control-plane/scripts/cpctl.ts` inlines the same quoting in its own
`enrollmentLines`; and `packages/control-plane/src/app.ts` has a third for `GET
/install.sh`, where the value substituted in is `publicUrl(c)` — the caller's
`Host` header — and an unquoted copy is remote code execution in a script people
pipe into `sh`. None of them can import another (two packages, and the image's
runtime stage carries no web `src`), so **`webcheck` reads all three off disk,
makes them callable and runs them over one hostile table**. The extraction finds
`function <name>(` at column 0 and reads to the next bare `}` in column 0:
nesting, renaming or an annotation it cannot strip makes that driver **throw**
rather than compare two things where it claims three. A fourth copy that joins
nothing is how the quoting stops agreeing.

**`installCommand` takes the origin the page is already on**, never a constant —
`packages/web/src/cp.ts` has no base URL at all for the same reason, so a
self-hosted instance prints a command that joins itself. **It is the only way a
machine is added from this app.** The by-name form on Settings → Machines, which
minted an enrollment code to carry to a host by hand, went on 2026-09-04: two
ways of doing one thing on a screen whose reader wants one, and the host with a
checkout runs the same script. `cpctl enroll` still mints a code for an operator.
It is drawn in three places — the rail's empty state below `lg`, the content
pane's `NothingSelected` at `lg` (where the rail is 280px and the pane beside it
was saying "pick a session" over an empty list), and Settings → Machines — and
**inside the `mayAddMachine` arm on all three**: a command that adds a machine,
printed under the sentence saying there is no way to add one, would leave
`machineQuotaNotice` literally `null`-iff-true while the property that pair
exists for was gone. It is deliberately **not** in `NewSession.tsx`'s
`MachineLine` — a field label in the composer strip on a 390px phone, beside a
door that already leads to the screen that has it. `webcheck` asserts the
placements and the form's absence. Since nothing in the tab adds a machine any
more, `store.ts`'s poll re-lists an empty fleet on every tick and re-reads `me`
when the first machine lands, which is how the machine enrolled from a terminal
appears without a wake.

## Layout

| File | Holds |
|---|---|
| `packages/web/src/enrollment.ts` | The three lines a daemon is started with, **and `installCommand`**, as shell **data**: `controlPlaneUrl` comes from the request's own `Host`, and a backtick survives `URL.origin`. `webcheck` runs `cpctl.ts`'s own `enrollmentLines` body off disk, so the copies are compared by behaviour |
| `packages/web/src/quota.ts` | How many machines *this person* may have, and what to say when they may not. `mayAddMachine` reads the control plane's own `canAddMachine` and **fails open** on absence — it gates the one-line installer, the only way a machine is added from this app; `webcheck` pins the pair — a notice is `null` **iff** the door is drawn. Also `machineLimitProblem`, the validator both admin screens call, and `machineLimitChangeNotice`, whose non-`null` **is** the decision to confirm a lowering |
| `packages/control-plane/src/machines.ts` | The label, the name that cannot collide, create-plus-grant in one transaction, `releaseOwner`, and `isUniqueViolation`, exported so a third caller one file over is not a third copy of a `"UNIQUE"` string match. `MAX_MACHINES_PER_USER` is the **ceiling** and lives here; the limit does not. `createOwnedMachine` takes the limit as a **required** argument, so both call sites are a compile error until they say which limit they mean |
| `packages/control-plane/src/quota.ts` | **The rank rule and nothing else** — one SQL statement answering owner, position and override together, and the clamp that keeps a row written by a looser release from out-ranking this one's ceiling. `null` from `machineStanding` means *nobody owns it* and every caller must read that as allowed: `?.over ?? true` is the natural spelling and takes every pre-ownership machine offline. Its own statement cache, because the SQL and the rule that reads it are one rule |

## Bounds

| | |
|---|---|
| Grants listing | 500 per page, 2000 max, with a `total` |
| Machines per user | **Ceiling 50; the limit is `machines.per_user`**, unset resolving to 50. Plus **one live enrollment code each** — minting burns the previous, which is why "how many codes may somebody hold" is not a number. The count is `machine_owners` rows with **no revoked filter**, so a revoke has to `releaseOwner` or the slot is spent for ever; `PUT …/owner` counts rows for *other* machines, so re-labelling one you already own is never your fifty-first |

**There is no link to rent a machine, and that is a deletion rather than an unset
default.** One sat under `installCommand` on all three screens until 2026-09-23
(Q1.650); `webcheck.shell-and-enrollment.ts` asserts the names it had are gone from
the client, and `deploycheck` that `main.ts` no longer reads
`REEMOAT_CP_MACHINES_OFFER_URL` by name — only its retirement list names it, to warn
an env file that still sets it. Bringing it back starts at Q1.632, whose placement
argument — inside the `mayAddMachine` arm, below the command — still holds.

## Links between one owner's machines

**A link is the owner's verb, and it is not a grant.** `POST /v1/machines/:id/links`
resolves `:id` as `POST /v1/tokens` does, then requires the caller to *own* it (a
grantee gets 404), and answers a link per other machine the caller owns that is
enrolled, keyed, live, granted to them and within the limit — finding the live
`machine_links` row or writing one, and minting a fresh capability on every call.
Each has `aud` the target, `sub` the owner and `LINK_SCOPE` only, and `cnf.jkt` is
the **source's** key from `machineKeyFor`, never from the request. It lives
`LINK_TOKEN_TTL_SECONDS`, because revocation is the relay reading the row.
`DELETE /v1/links/:id` belongs to the owner of either end and is idempotent; the
next sync links the pair again with a new id, so it replaces a token rather than
parting two machines (Q7.151). No link path writes `grants`, and `LINK_SCOPE` must
never enter `ALL_SCOPES`, which is what a grant stores. Q1.652.
