-- Control-plane state. Re-applied on every open; every statement is idempotent.
--
-- Read at runtime with readFileSync(new URL("./schema.sql", import.meta.url)),
-- exactly as the daemon reads its own. No build step, so this file sits beside
-- the module that loads it.
--
-- This database is more sensitive than the daemon's: it holds the private
-- signing key that mints every token in the fleet, plus one hash per API key.
-- It is created 0600 inside a 0700 directory for that reason.
--
-- ⚠ **This package has a `migrate()` now, and several comments below still say it
-- does not.** They are kept as written rather than swept, because each one is the
-- argument for a *table* where a column would have been the obvious shape, and
-- that argument outlived the constraint that prompted it: **the absence of a row
-- is meaningful**, which no nullable column can express. Read "this package has
-- no migrate()" in what follows as "when this was written there was no way to add
-- a column at all" — true then, and still not a reason to go back and turn any of
-- those tables into one.
--
-- What `migrate()` in `store.ts` is for is the case those tables cannot serve: a
-- fact that genuinely belongs *on* an existing row. It has one rule, and the rule
-- is what makes a weekly release safe to roll back: **additions only, and
-- `CP_SCHEMA_VERSION` does not move for them.** A nullable column an older build
-- never selects is invisible to it, so yesterday's image still starts against
-- today's database. Bumping the version instead makes `checkSchemaVersion` refuse
-- the file, `main.ts` exit(2), and the unit restart into a crash loop that takes
-- the relay — and therefore the whole fleet's reachability — with it.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- u_<hex>
  name        TEXT    NOT NULL UNIQUE,
  -- Admin is a flag on a user, not a second authentication system. One way in,
  -- one thing to get right.
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  -- Set to disable, which is the reversible act and the usual one: the row stays,
  -- `callerAuth` reads this live, and `enable` puts it back.
  --
  -- This used to read "rows are never deleted", and `DELETE /v1/admin/users/:id`
  -- means it no longer can. What that sentence was protecting is real and is now
  -- stated where it bites instead: `enrollment_codes.created_by` can name a user
  -- who is gone, and is deliberately left dangling — an audit row's job is to say
  -- what happened, and rewriting it to keep a join valid is the opposite of one.
  -- What the sentence was **not** protecting is a list of people that grows for
  -- ever because somebody who left in March can only ever be greyed out.
  disabled_at INTEGER,
  -- When the person last chose a password themselves: written by
  -- `POST /v1/me/password` and by the mailed reset (`POST /v1/reset`), and by
  -- nothing else. An admin-issued temporary password and the bootstrap in
  -- `main.ts` leave it alone — neither is the person choosing anything, and the
  -- settings screen draws this as "Changed <age> ago", which would be a lie for
  -- a value somebody else set. NULL for every row that predates the column and
  -- for every account whose password was only ever issued; the screen says
  -- "Set" there rather than inventing a date. Added by `migrate()` in `store.ts`
  -- on an existing database — this CREATE only reaches a fresh one.
  password_changed_at INTEGER
);

-- `users.name` is UNIQUE and therefore BINARY-indexed, which `WHERE lower(name)
-- = ?` cannot use. Both of `registration.ts`'s name probes are written that way,
-- and they sit on `POST /v1/register` — unauthenticated, above THE LINE — so
-- every sign-up attempt scanned the whole table. An expression index is the
-- match; the alternative, a stored `name_folded` column, is exactly what this
-- package cannot add, because `schema.sql` is re-applied on every open and
-- `CREATE TABLE IF NOT EXISTS` is useless for a new column.
CREATE INDEX IF NOT EXISTS idx_users_name_folded ON users (lower(name));

-- API keys were once the only human credential. They are now the credential for
-- everything that is not a browser: `cpctl`, a script, and getting back in when
-- the control plane has been rolled back past the release that added passwords.
-- A person signs in with a name and a password (see `user_passwords` and
-- `user_sessions` below). There is still no OAuth, and that stays deliberate;
-- email and a reset flow are built (`user_emails`, `user_email_tokens`).
--
-- **This row is not a way back from a forgotten password, and it never was.**
-- `POST /v1/me/password` requires the current password whenever a
-- `user_passwords` row exists, whichever credential is presenting — so a key
-- holder who has forgotten their password can read and act as the account and
-- still cannot replace the password. That sentence used to read "getting back in
-- when a password is lost", which was false when it was written. What is
-- actually the way back is `POST /v1/forgot`, and it needs a verified address.
-- Where there is no SMTP there is no recovery; see Q7 in docs/DECISIONS.md.
--
-- **No route mints one of these for anybody but the caller.** The bootstrap in
-- `main.ts` is not a route and has no caller — it is the fleet coming into
-- existence. Everything else issues only to an account that has just proved
-- something about itself, which is why `POST /v1/admin/users/:id/keys` and
-- `withKey` are gone: an admin may revoke a key and may never issue one.
--
-- What did not change is that this row is unchanged: every existing key keeps
-- working, which is what stops a deploy signing the fleet out.
--
-- Only a hash is stored. `prefix` is the first few characters of the key, kept
-- in the clear and indexed, so a lookup is one indexed probe rather than a scan
-- that hashes every row — and so a human can recognise their own key in a list
-- without it being reproducible from what is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,           -- ak_<hex>
  user_id    TEXT    NOT NULL,
  prefix     TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  -- When this key last authenticated a request, so a row in a list of ten can
  -- say which one `cpctl` on the old laptop is still holding. Written by
  -- `callerAuth` on an accepted bearer lookup and **at most once a minute per
  -- key**: this table sits on every authenticated request and a write per
  -- request would put a disk write on the path every tunnel shares (see
  -- `user_sessions.last_seen_at`, which keeps the same discipline at fifteen
  -- minutes). A revoked key is refused before the write, so its value stops
  -- where the revocation found it. NULL means never used since the column
  -- existed — indistinguishable from never used at all, and nothing needs to
  -- tell them apart. Added by `migrate()` on an existing database.
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
-- Every per-user read of this table went through a scan: `GET /v1/admin/users`
-- counts live keys with a correlated subquery once per row, and `POST
-- /v1/me/keys` counts them before minting. Both are `WHERE user_id = ?`, which
-- `idx_api_keys_prefix` cannot serve.
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

-- A password, in a table of its own rather than a column on `users`.
--
-- The reason is `machine_tunnel_keys`', one for one: this file is re-applied on
-- every open, `CREATE TABLE IF NOT EXISTS` is idempotent for a whole table and
-- useless for a new column on an existing one, and this package has no migrate().
-- A `password_hash` column would exist on every database created after this
-- commit and be silently absent on every database created before it — which is
-- the shape of bug where the admin's own login works on a fresh install and 500s
-- on the deployment that matters.
--
-- **The absence of a row is meaningful and is the migration.** Every user that
-- existed before this feature has none: they authenticate with their API key, and
-- set a first password with no current password to prove, because the key they
-- are holding was already full authority over the account.
--
-- `hash` is self-describing — `scrypt$N$r$p$<salt>$<dk>` — rather than five
-- columns, for the same no-migrate reason: raising N later must not need a schema
-- change or it cannot happen at all. It is also what makes verification correct,
-- because a verifier must read the parameters a hash was *written* with rather
-- than the ones the process currently prefers. See `password.ts`.
CREATE TABLE IF NOT EXISTS user_passwords (
  user_id    TEXT PRIMARY KEY,
  hash       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A signed-in browser, which is a bearer credential and nothing more.
--
-- **Not a cookie.** `src/cors.ts` sends `Access-Control-Allow-Origin: *` and
-- deliberately never sends `Access-Control-Allow-Credentials`, and that wildcard
-- is only safe because no credential is ever ambient. A cookie would also hand
-- `POST /v1/tokens` — which mints a machine token — to any page that can make the
-- browser issue a request. So this is a token the client stores and puts in an
-- `Authorization` header itself, exactly like the API key beside it: same
-- three-character prefix so `keyPrefix` works unchanged, same clear-text `prefix`
-- column, same indexed probe.
--
-- sha256 rather than scrypt, and that is not an inconsistency with
-- `user_passwords`: this value is 32 bytes from the CSPRNG, so there is no
-- dictionary to run against it and a KDF would only make the hot read path 50ms
-- slower. The KDF is for the one credential a human chose.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,         -- s_<hex>
  user_id      TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Absolute, written once, never extended on use. A sliding window would mean a
  -- write on the authentication path of the process that also carries every relay
  -- tunnel, against a database running `synchronous = FULL` — an fsync per
  -- request. `last_seen_at` below is the compromise: it moves at most once every
  -- fifteen minutes and nothing authenticates against it.
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- Set by signing out, by "sign out everywhere", and by a password change. Rows
  -- are revoked rather than deleted for the same reason `users` rows are: a list
  -- somebody is shown should be able to say a session ended rather than forget it.
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_prefix ON user_sessions (prefix);
-- The session list and both revoke sweeps are all "this user's, newest first", so
-- none of them is a scan of every session in the fleet.
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id, created_at);

-- Where a sign-in came from, so the list of them can be read by a human.
--
-- A table rather than two columns on `user_sessions`, for the reason stated three
-- times above and once more here because it is the *only* reason this is not a
-- column: this file is re-applied on every open, `CREATE TABLE IF NOT EXISTS` is
-- idempotent for a whole table and useless for a new column, and this package has
-- no migrate(). An `ip` column would exist on every database created after this
-- commit and be silently absent on every one created before it.
--
-- **Absence is meaningful and is the migration**, exactly as it is for
-- `user_passwords`: a session that predates this table has no row, and the list
-- says so rather than inventing a device. Rows here are deleted with their
-- session by `pruneSessions` — `PRAGMA foreign_keys = OFF` is set in `store.ts`,
-- so there is no cascade doing it for us.
--
-- **Neither value is evidence, and nothing may ever authorize on them.** Both are
-- caller-supplied: `user_agent` is a request header, and `ip` is the socket
-- address only when there is no proxy in front (see `net.ts`). Somebody holding a
-- stolen token can set both. This list exists so a person can *end* sessions, not
-- so they can judge which one is theirs and trust the answer.
CREATE TABLE IF NOT EXISTS user_session_origins (
  session_id TEXT PRIMARY KEY,
  -- Bounded at ingest in `sessions.ts`. Unbounded caller-supplied strings do not
  -- go into this database.
  ip         TEXT,
  user_agent TEXT
);

-- Who created a machine, and what they call it.
--
-- Users mint their own enrollment codes now, so "may this caller manage this
-- machine" needs an answer the admin cannot change by accident. `grants` cannot
-- give it: a grant is full access and several people may hold one, so the owner
-- would be the earliest grantee and `DELETE /v1/admin/grants` would silently
-- transfer ownership. `enrollment_codes.created_by` cannot either — it is per
-- code, absent until one is minted, and burned when a machine is revoked.
--
-- `label` is what its owner calls it, and it is here rather than in `machines`
-- because `machines.name` is globally UNIQUE and cannot stop being: two people
-- both naming a machine "laptop" would collide, and the 409 would tell the second
-- one that somebody else has one by that name. So `machines.name` for a
-- user-created machine is written unique by construction and never shown, while
-- the unique index below scopes the pretty name to its owner — where a collision
-- is with your own machine and leaks nothing.
--
-- **A machine created before this table existed has no row here**, and is
-- therefore admin-managed exactly as it is today. That is the correct answer
-- rather than a gap: nobody created it through the route that would have written
-- one.
--
-- `created_at` is **when this user acquired the machine**, not when the machine
-- was created — `PUT /v1/admin/machines/:id/owner` writes a fresh one on
-- adoption, and `releaseOwner` destroys the old one on a revoke. That was a
-- detail nobody had to read until the machine limit started ordering on it:
-- `quota.ts` ranks a person's machines oldest-acquisition-first, so this column
-- decides which machine stops working when their limit goes down. The same route
-- is also the admin's re-label, and it preserves this value when the owner is
-- unchanged for exactly that reason.
CREATE TABLE IF NOT EXISTS machine_owners (
  machine_id TEXT PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_owners_label ON machine_owners (user_id, label);
CREATE INDEX IF NOT EXISTS idx_machine_owners_user ON machine_owners (user_id, created_at);
-- The rank query in `quota.ts` counts a machine's older siblings and breaks ties
-- on `machine_id`, so it needs that column in the index or every counted row is a
-- table lookup. `idx_machine_owners_user` carries (user_id, created_at) and stops
-- one column short; this makes the count a covering index scan, on a query that
-- runs on the relay's per-request path.
CREATE INDEX IF NOT EXISTS idx_machine_owners_rank ON machine_owners (user_id, created_at, machine_id);

CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,          -- m_<hex>
  name        TEXT    NOT NULL UNIQUE,
  -- `base_url` used to sit here: where a browser should connect directly, with
  -- the control plane handing it out and then getting out of the way. Users do
  -- not reach machines directly any more, so there is no address to record and
  -- nothing to hand out — every request goes down the tunnel the daemon dialled.
  --
  -- Removed from this file rather than migrated away. `migrate()` adds and never
  -- drops, and every statement here is CREATE ... IF NOT EXISTS, so a
  -- database written by an older control plane keeps a nullable column that
  -- nothing reads. That is the whole cost, and it is smaller than introducing a
  -- migration mechanism for one dead column.
  created_at  INTEGER NOT NULL,
  -- NULL until a daemon redeems an enrollment code for this machine.
  enrolled_at INTEGER,
  -- Revocation is control-plane-side only. Setting this stops new tokens being
  -- minted; tokens already issued keep working until they expire, because the
  -- daemon never asks us anything. That bound is the token lifetime and nothing
  -- else, and it is the accepted price of a daemon that survives our outage.
  revoked_at  INTEGER
);

-- The admin lists all sort by creation. Indexed rather than sorted in memory,
-- and safe to add here: `CREATE INDEX IF NOT EXISTS` is idempotent, which is
-- what makes an index a schema.sql change while a new *column* has to go through
-- `store.ts`'s migrate().
CREATE INDEX IF NOT EXISTS idx_machines_created_at ON machines (created_at);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);

CREATE TABLE IF NOT EXISTS grants (
  user_id    TEXT    NOT NULL,
  machine_id TEXT    NOT NULL,
  -- Space-separated, like an OAuth scope string. Denormalized on purpose: the
  -- set is tiny, always read whole, and never queried by member.
  scopes     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_id)
);

-- Grants are users × machines, so this is the one admin list that grows with the
-- product of the fleet. It is paged, and the page is ordered by creation.
CREATE INDEX IF NOT EXISTS idx_grants_created_at ON grants (created_at);

-- The keys that sign tokens.
--
-- Plural, and retired rather than deleted, so a rotation can overlap: both keys
-- are published while daemons re-enroll, then the old one is retired. A daemon
-- never re-fetches, so the overlap is the only safe way to rotate.
CREATE TABLE IF NOT EXISTS signing_keys (
  kid         TEXT PRIMARY KEY,          -- k_<hex>
  private_pem TEXT    NOT NULL,
  public_jwk  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);

-- Single-use, expiring credentials that a daemon exchanges once for its identity.
--
-- `code_hash` is UNIQUE and the redemption is a conditional UPDATE against
-- `used_at IS NULL`, so single-use is a property of the database rather than of
-- application logic that could be raced. The plaintext is shown once, at
-- creation, and never stored.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id         TEXT PRIMARY KEY,           -- ec_<hex>
  code_hash  TEXT    NOT NULL UNIQUE,
  machine_id TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  -- Which address redeemed it. Cheap, and the only forensic trail there is if a
  -- code is used by somebody it was not handed to.
  used_from  TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollment_codes_machine ON enrollment_codes (machine_id);

-- The credential a daemon proves its identity with when it dials the relay.
--
-- Enrollment hands a daemon a machine id and the *public* keys that verify
-- tokens addressed to it. Neither proves anything on the way back: a public key
-- is public, and a machine id is a name. So a daemon that wants to hold a tunnel
-- needs a secret of its own, and this is it.
--
-- Hashed exactly like an API key, with the same clear-text `prefix` for the
-- indexed probe, because it is the same kind of credential and there is no
-- reason for a second scheme. The plaintext is returned once, from /v1/enroll,
-- and never stored.
--
-- A table rather than columns on `machines` for two reasons: `schema.sql` is
-- re-applied on every open and `CREATE TABLE IF NOT EXISTS` is idempotent for a
-- whole table but useless for a new column on an existing one — the control
-- plane has no migrate() and this is not the change that should introduce one —
-- and rows here are retired rather than deleted, so a re-enrollment can revoke
-- the old credential while leaving the audit trail behind.
CREATE TABLE IF NOT EXISTS machine_tunnel_keys (
  id         TEXT PRIMARY KEY,           -- mt_<hex>
  machine_id TEXT    NOT NULL,
  prefix     TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_machine_tunnel_keys_prefix ON machine_tunnel_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_machine_tunnel_keys_machine ON machine_tunnel_keys (machine_id);

-- ------------------------------------------------------------------ --
-- Email, registration, and the settings an admin may change at runtime.
--
-- Six tables, no new columns, and `CP_SCHEMA_VERSION` deliberately left at 1.
-- `checkSchemaVersion` refuses a file written by a *newer* control plane, and
-- `main.ts` turns that refusal into `exit(2)` under a unit that restarts — a
-- crash loop that takes the relay, and therefore the whole fleet's
-- reachability, down with it. A rollback is what you do when a release is
-- broken; it must not be the thing that breaks everything else. Old code opens
-- a file carrying these tables and simply never selects from them, which is the
-- mirror of the `machines.base_url` removal above.
-- ------------------------------------------------------------------ --

-- Settings an admin may change without a redeploy.
--
-- **Key/value rows, and not one row with a column per setting.** The usual
-- reason applies — this package has no migrate(), so a `smtp_starttls` column
-- added in a later release is present on every database created after that
-- commit and silently absent on every one created before it. But the argument
-- that actually decides the shape is better than that: **the absence of a row
-- is precisely what "fall back to the environment" means.** This table's
-- semantics and this package's migration story are the same sentence, which is
-- not true of any other shape. That is why it is key/value, and why it should
-- not be "tidied" into columns later.
--
-- The cost, stated: every value is TEXT and somebody has to parse. That is
-- confined to the typed readers in `settings.ts`, which is where hand-written
-- validation belongs here anyway.
--
-- **This is the second place this database holds a recoverable secret**, beside
-- `signing_keys.private_pem`: `smtp.password` is a credential that must be
-- presented to a remote server, so it cannot be hashed. It is 0600 inside a
-- 0700 directory for the reason stated at the top of this file, and it is
-- never returned by any route — `GET /v1/admin/settings` projects it to a
-- boolean, never a value and never a masked prefix.
--
-- `updated_by` names a user and is **left dangling** when that user is deleted,
-- for `enrollment_codes.created_by`'s reason verbatim: an audit row's job is to
-- say what happened, and rewriting it to keep a join valid is the opposite of
-- one. So this table is deliberately *not* in the user-delete sweep.
--
-- Nothing seeds it. A seed written here would be re-executed on every open —
-- this file is applied at every startup — and would overwrite an admin's change
-- at every restart, with the symptom "registration turns itself back on after a
-- deploy".
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- A sign-up that nobody has confirmed yet.
--
-- **Not a `pending` flag on `users`, and the reason is not the migration one.**
-- A half-created row in `users` would be counted by `GET /v1/admin/users`, would
-- be a real login name against a UNIQUE index, and — the part that decides it —
-- would squat that name for ever, because there is no way to release a
-- `users.name` except by deleting the person. A separate table lets an
-- *expired* registration stop holding the name, since every probe filters
-- `used_at IS NULL AND expires_at > ?`.
--
-- `password_hash` is written here, at registration, rather than at
-- confirmation. Three reasons in order of weight: the SMTP-unconfigured arm
-- takes a password at registration by definition, so doing it in both arms
-- means one form and one policy check; confirmation then does no KDF at all,
-- which is what makes an unauthenticated route that writes to `users` cheap
-- enough to exist; and it means every branch of `POST /v1/register` — name
-- taken, address taken, fresh — spends the same ~51ms, which is the login
-- route's own rule applied to a new door.
--
-- `token_hash` is UNIQUE and redemption is a conditional UPDATE followed by
-- `changes === 1`, which is `enrollment_codes`' template byte for byte.
--
-- The folded columns are stored rather than computed, and the fold is one
-- exported function in TypeScript so the insert and the probe cannot disagree.
-- Note the asymmetry honestly: `users.name` is UNIQUE **BINARY**, so `Ada` and
-- `ada` are two accounts today and this does not change that. The folded
-- pre-check is *friendlier* than the index; the UNIQUE violation at confirm
-- time is the honest backstop.
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            TEXT PRIMARY KEY,          -- pr_<hex>
  token_hash    TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  name_folded   TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  email_folded  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  -- The confirming address, or a burn reason: 'superseded', 'name_taken',
  -- 'email_taken'. The same forensic column `enrollment_codes.used_from` is,
  -- and the reason is a required argument rather than a literal inside a
  -- function, so the wrong one is not the easy one to write.
  used_from     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_name ON pending_registrations (name_folded, used_at);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_email ON pending_registrations (email_folded, used_at);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires ON pending_registrations (expires_at);

-- The address an account can be reached at, and therefore reset from.
--
-- **Absence is meaningful and is the migration**, exactly as it is for
-- `user_passwords`: every account that exists today has no row here, and
-- `GET /v1/me` says `email: null` rather than reading `""` off a column that may
-- not exist. Such an account cannot reset a password until somebody adds an
-- address under Settings → Account, and that is the honest state rather than a
-- gap.
--
-- One row per user, overwritten on change, rather than "a primary address plus
-- a pending one": two states plus a merge rule is a second state machine, and
-- the account's address becomes a question with two answers. The cost is stated
-- rather than designed around — changing your address to a typo un-verifies you
-- and there is no old address to fall back to — which is why the notice to the
-- *old* address is sent before this row is overwritten.
--
-- **The partial unique index is the load-bearing one and it is not
-- decoration.** A plain UNIQUE on `email_folded` would let anybody squat any
-- address by merely *claiming* it, permanently blocking the real owner from
-- ever verifying it, from an anonymous route. Scoping uniqueness to verified
-- rows says: an unverified claim reserves nothing. Two accounts may both claim
-- `a@b`; the first to prove it wins; the second's verification answers 409 and
-- their row stays unverified. That is also what makes "a taken address answers
-- the same 200 as a fresh one" implementable without an enumeration oracle.
CREATE TABLE IF NOT EXISTS user_emails (
  user_id      TEXT PRIMARY KEY,
  -- As typed, for display. Folded, for every comparison.
  email        TEXT    NOT NULL,
  email_folded TEXT    NOT NULL,
  -- NULL means claimed and unproved, which is worth nothing: it reserves no
  -- address and `POST /v1/forgot` will not mail it.
  verified_at  INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_folded ON user_emails (email_folded);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_verified
  ON user_emails (email_folded) WHERE verified_at IS NOT NULL;

-- Single-use links mailed to an address: proving one, and resetting through one.
--
-- One table with a `purpose` column rather than two tables, and the argument is
-- `mintEnrollmentCode`'s own recorded lesson: the claim, the burn, the per-user
-- supersede and the sweep would otherwise exist as two hand-written copies of
-- one conditional UPDATE, which is how they come to disagree about one of its
-- clauses. `pending_registrations` stays separate because it is genuinely a
-- different thing — it carries a whole prospective account.
--
-- **`email_folded` on the token is load-bearing.** Without it: ask to verify
-- `a@b`, change your address to `c@d`, click the old link, and `c@d` is
-- verified on proof of `a@b`. Every claim joins `user_emails.email_folded` and
-- refuses on mismatch, which also makes changing your address invalidate
-- outstanding resets for free.
--
-- Burned by a password change, an address change, `disable` and `delete`.
-- **`disable` matters more than it looks, and for `burnUserCodes`' exact
-- reason**: `POST /v1/reset` sits above THE LINE, has no caller at all, and
-- would otherwise let a banned account redeem a link it was mailed minutes
-- earlier. That route re-reads `disabled_at` as well — two independent answers,
-- because one of them is a sweep somebody can forget.
CREATE TABLE IF NOT EXISTS user_email_tokens (
  id           TEXT PRIMARY KEY,           -- ut_<hex>
  user_id      TEXT    NOT NULL,
  -- 'verify' | 'reset'. An invitation is a 'reset' against an account that has
  -- no password yet, which is the same act by a different name and needs no
  -- third member.
  purpose      TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  email_folded TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  used_from    TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_email_tokens_user ON user_email_tokens (user_id, purpose, used_at);
CREATE INDEX IF NOT EXISTS idx_user_email_tokens_expires ON user_email_tokens (expires_at);

-- Messages waiting to be sent, and the record that they were.
--
-- A table rather than an in-memory queue because the process restarts: a
-- confirmation lost to a deploy is a person who clicked a button and got
-- silence, whose only remedy is to sign up a second time and hope. It is also
-- the only thing that makes "did it actually go out" answerable at all.
--
-- **`body` is a live credential while it is here.** It holds the rendered
-- message, including the one-time link. That is not worse than what is already
-- in this file — the private key that mints every token in the fleet is two
-- tables up — but the window is bounded on purpose: it is cleared in the same
-- statement that writes `sent_at`, and on failure it is kept only until
-- `not_after`, because a failed message is exactly the one an operator retries
-- after fixing SMTP.
--
-- `not_after` is the queue's deadline, set by the enqueuer to the token's own
-- expiry. It exists so the transport can stay ignorant of what it carries: a
-- message past its deadline is failed *without dialling*, which is a property
-- of the queue rather than of the SMTP client. It is also what stops a reset
-- that expires in an hour being retried for four.
--
-- Not swept by user delete, and deliberately: a row here is keyed by address
-- rather than by user, because a registration message has no user yet. What
-- makes that safe is that **the outbox never authorizes anything** — the token
-- table does, and delete burns tokens.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         TEXT PRIMARY KEY,             -- mo_<hex>
  to_address TEXT    NOT NULL,
  to_folded  TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body       TEXT,
  created_at INTEGER NOT NULL,
  not_after  INTEGER NOT NULL,
  -- Doubles as the lease: claiming writes `now + LEASE_MS` here, so a pump that
  -- crashed mid-send leaves a row that becomes eligible again rather than one
  -- that is stuck. A `claimed_at` column would need a second sweep to undo.
  next_at    INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER,
  failed_at  INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mail_outbox_ready
  ON mail_outbox (next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_outbox_created ON mail_outbox (created_at);
-- One rule needs this one: at most one "somebody tried to register with your
-- address" notice per address per day. That message is sent to a third party on
-- an anonymous request, so it is the vector the "a taken address answers the
-- same 200" decision creates, and this index is what bounds it.
CREATE INDEX IF NOT EXISTS idx_mail_outbox_notice ON mail_outbox (to_folded, kind, created_at);

-- An account that must replace its password before it can do anything else.
--
-- The presence of a row **is** the obligation; there is no boolean and no
-- column. It could not be derived either: nothing else records "an admin chose
-- this password", and `user_passwords.updated_at` cannot tell an admin-set hash
-- from a self-set one.
--
-- `reason` is a union with one member today, and it is still a union for
-- `UserCodeBurnReason`'s reason — this column is the only trail there is, and a
-- typo in it is indistinguishable from an event that never happened.
--
-- Worth noticing: `'admin_created'` is reachable on **every** instance, not only
-- on one with no mail. The arm is chosen by whether the admin supplied an
-- address, not by whether SMTP is configured — `POST /v1/admin/users` takes the
-- generated-password branch whenever `email` is absent, and the Users screen
-- offers exactly that choice with mail working. Said precisely because the
-- earlier wording here read as a guarantee about which accounts can carry the
-- wall, and reasoning about THE SECOND LINE from it would be wrong.
--
-- Cleared by `POST /v1/me/password` and by `POST /v1/reset`, each inside the
-- same transaction as the hash it writes. **Not** cleared by `enable`:
-- re-enabling an account restores the account, not the absence of an
-- obligation, which is the same sentence `enable` already makes about sessions.
CREATE TABLE IF NOT EXISTS password_obligations (
  user_id    TEXT PRIMARY KEY,
  reason     TEXT    NOT NULL,             -- 'admin_created'
  created_at INTEGER NOT NULL
);

-- How many machines one person may own, when the instance default is not the
-- answer for them.
--
-- **The absence of a row is what "use the instance default" means**, which is
-- `instance_settings`' idiom one table over and is here for a sharper version of
-- its reason. A `max_machines` column on `users` is not available — this package
-- has no migrate(), `schema.sql` is re-applied on every open, and
-- `CREATE TABLE IF NOT EXISTS` is idempotent for a whole table and useless for a
-- new column on an existing one. But even with a migrate this would be a table:
-- **0 is a real limit** ("this account may own no machines"), so a nullable
-- column would need a second way to spell "unset" and the two would come to
-- disagree.
--
-- **Nothing here suspends a machine.** Being over the limit is derived on read,
-- from a machine's rank among its owner's machines ordered by
-- `(machine_owners.created_at, machine_id)` — so lowering this number takes the
-- most recently acquired machines off the network and raising it hands them back,
-- with no recompute anywhere and no state that can go stale. See `quota.ts`.
--
-- Bounded above by `MAX_MACHINES_PER_USER` in `machines.ts`, which is a different
-- bound and stays: that one is the anti-abuse ceiling (a machine is a row plus a
-- code plus a tunnel credential, against a `synchronous = FULL` file in the
-- process carrying every tunnel), this one is the commercial limit an admin
-- raises to sell. A write above the ceiling is refused on the route and clamped
-- again on read.
--
-- `updated_by` names **a user or a provisioning key**, and is left dangling when
-- either is gone — exactly as `instance_settings.updated_by` and
-- `enrollment_codes.created_by` are, and for their reason. The two namespaces are
-- told apart by prefix (`u_` against `pk_`), which is the same answer
-- `enrollment_codes.created_by` gives and for the same cause: `POST /v1/provision`
-- raises somebody's limit to fit the machine it is creating, and writing the
-- owner's id there would say they raised their own. A `pk_…` in this column is
-- greppable and true. The *subject's* own row is swept by
-- `DELETE /v1/admin/users/:id`, by hand, because `PRAGMA foreign_keys = OFF`
-- means nothing here cascades.
CREATE TABLE IF NOT EXISTS user_machine_limits (
  user_id      TEXT PRIMARY KEY,
  max_machines INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT
);

-- The one credential that provisions a machine for somebody else.
--
-- **What it is for.** Adding a daemon needed a credential belonging to the
-- person who would own it: their own sign-in for the web form, or an API key for
-- `cpctl`. So an admin setting a host up for somebody had to either borrow their
-- account or hand them a credential — and an admin's *own* key would work but is
-- full authority over the fleet, which is not a thing to paste into a install
-- script on somebody else's laptop.
--
-- **What it authorizes, exhaustively:** `POST /v1/provision` — create a machine
-- owned by a named user, raise that user's machine limit far enough for it to
-- work, and mint its single-use enrollment code. Nothing else. It is not a
-- `callerAuth` credential, it authenticates no session, it reads nothing, and it
-- cannot revoke, rename, grant, or touch a user.
--
-- ⚠ **It is still a serious credential, and the threat is not the obvious one.**
-- Somebody holding it cannot read anybody's work — but they can insert a machine
-- of *their own* into any user's list, and that user may then run agents on the
-- attacker's host. The mitigation is rotation, which is why this is a table with
-- `revoked_at` rather than a value in `instance_settings`: rotating has to make
-- the old one stop working in the same statement that mints the new one.
--
-- Only the hash is kept, like every other credential here. The plaintext exists
-- in one response body and nowhere else; an admin who loses it rotates.
--
-- **At most one is ever live**, and minting is the only verb: `POST` retires the
-- previous row in the same transaction that inserts the new one, because the
-- reason to mint a second is that the first leaked and a window in which both
-- work is the window being closed. There is no revoke and no way to turn
-- provisioning off, deliberately — "off" would be a third state to reason about
-- for a fleet that either hands out hosts or does not.
--
-- Rows are kept rather than deleted so `created_by` and `revoked_at` say who
-- minted what and when it stopped working, which is the only trail there is for
-- a credential that provisions hardware. **Nothing reads `prefix` or `id`** —
-- no screen and no command prints any part of this key — and they are stored
-- anyway so that trail is legible in the database itself.
CREATE TABLE IF NOT EXISTS provisioning_keys (
  id         TEXT PRIMARY KEY,           -- pk_<hex>
  prefix     TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provisioning_keys_prefix ON provisioning_keys (prefix);

-- ------------------------------------------------------------------ --
-- Which machines are holding a tunnel, written by the relay and read by
-- everything else.
-- ------------------------------------------------------------------ --

-- Tunnel *presence*, which is the only part of a tunnel that can be written down.
--
-- A tunnel is a TLS-wrapped WebSocket carrying an HTTP/2 session: a kernel fd
-- plus TLS keys, h2 stream tables, flow-control windows and ws framing state,
-- all of it in one process's heap. None of that is serializable and none of it
-- survives the process, so a relay restart always costs a redial and no table
-- can change that. What *is* movable is the fact of the connection — which is
-- the part another process needs, and the reason this table exists at all: with
-- the relay in its own container, `relayOnline` on `POST /v1/tokens` and
-- `GET /v1/admin/relay` have no in-memory registry to ask.
--
-- Written **only** by the relay, best-effort, and never on the request path: an
-- upsert when a tunnel registers, a delete when it unregisters, and one
-- transaction every few seconds that re-stamps `last_seen_at` for what is live
-- and deletes what this relay did not touch. A failed write costs one stale row
-- for one tick and must never reach a tunnel's lifecycle.
--
-- Read with a staleness window rather than as truth, because a relay that is
-- killed hard leaves its rows behind. The window errs toward *present*: a stale
-- `true` costs one probe and a `503 no_tunnel`, which every client already turns
-- into "forget the route and re-resolve", while a stale `false` renders a
-- reachable machine as offline with nothing to correct it.
--
-- `relay_id` is a deployment slot, not a process — its replacement clears the
-- dead one's rows at boot by name. It is also the seam for more than one relay:
-- a second column carrying that relay's own address is what a machine-to-peer
-- forward would need. Not built, and until it is, `machine_id` being the primary
-- key means two relays would fight over a row.
CREATE TABLE IF NOT EXISTS relay_tunnels (
  machine_id       TEXT PRIMARY KEY,
  relay_id         TEXT    NOT NULL,
  connected_at     INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  requests_proxied INTEGER NOT NULL DEFAULT 0,
  active_streams   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_relay_tunnels_relay ON relay_tunnels (relay_id, last_seen_at);

-- Which process currently owns a relay slot.
--
-- `relay_tunnels.relay_id` is a *slot* rather than a process: a relay that is
-- killed hard cannot delete its rows, so its replacement clears them by name at
-- boot, and `sweep` deletes rows under that name it did not stamp. All of which
-- is correct for one relay per name and quietly destructive for two — each
-- sweeps the other's machines every five seconds, and the fleet flaps.
--
-- Nothing enforced that. This does: a relay claims its name here at boot and
-- refuses to start if a *live* other process holds it. The daemon's single-row
-- `daemon` table is the precedent, with one difference that decides the shape —
-- a relay runs in a container, so `pid` and `os.uptime()` mean nothing across
-- namespaces. Liveness is therefore a heartbeat, stamped by the same flush that
-- already runs every five seconds, and `nonce` is what tells one process from
-- another under one name.
CREATE TABLE IF NOT EXISTS relay_instances (
  relay_id     TEXT PRIMARY KEY,
  nonce        TEXT    NOT NULL,
  claimed_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- When a machine was last known to be connected.
--
-- `relay_tunnels` is deleted on disconnect — that is what makes it *presence* —
-- so "offline for a minute" and "offline for a week" were the same answer
-- everywhere in the product: one boolean, `relayOnline`, and nothing behind it.
-- You could not tell a closed laptop from a VPS that died on Tuesday, could not
-- alert on "offline > 24h", and could not answer the first question anybody asks
-- about a machine that is not responding, which is when it last worked.
--
-- **A table rather than a column on `machines`**, and it was not a preference
-- when it was written: this package had no `migrate()`, and `schema.sql` is
-- re-applied on every open with every statement `CREATE ... IF NOT EXISTS` —
-- idempotent for a whole table and useless for a new column. `user_passwords`,
-- `machine_owners` and `user_machine_limits` are all this shape for that reason.
--
-- ⚠ **`migrate()` exists now, and `machines.daemon_seen_at` is a column recording
-- something adjacent — so this comment reads as an oversight unless the second
-- reason is stated.** They are different facts. `daemon_seen_at` is *when a
-- daemon last dialled and said what it was*, written once per handshake on the
-- tunnel path; this is *when a tunnel was last known up*, written by the relay's
-- 5s presence flush and read to answer how long a machine has been dark. Folding
-- either into the other would put a per-flush write on the row every proxied
-- request reads. What is genuinely stale is only the "no `migrate()`" half.
--
-- Written by the relay, on the flush it already runs, and **never on the request
-- path**: this is bookkeeping about a tunnel rather than anything a request
-- depends on, and it is subject to the same best-effort rule as every other write
-- in `presence.ts`. A lost stamp costs a five-second-stale answer to a question
-- measured in hours.
--
-- No foreign key, deliberately, for `enrollment_codes.created_by`'s reason: a row
-- here is a fact about what happened, and a machine that was revoked and swept
-- should not take the record of when it last worked with it before an operator
-- has had a chance to read it.
CREATE TABLE IF NOT EXISTS machine_last_seen (
  machine_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
);
