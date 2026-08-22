-- Reemoat durable state. Re-applied on every open; every statement is idempotent.
--
-- Read at runtime with readFileSync(new URL("./schema.sql", import.meta.url)).
-- There is no build step, so this file simply sits beside the module that loads
-- it. If a bundler ever appears, it has to be carried across as an asset.
--
-- Pragmas are deliberately NOT here: `PRAGMA journal_mode = WAL` returns a row,
-- so it has to go through prepare().get() where the result can be checked.
-- See openStores().

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  agent            TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  -- The agent's own session id. This is the whole resume story: ACP hands it
  -- back from session/new and accepts it on session/resume, and every agent
  -- keeps its side of it on disk.
  agent_session_id TEXT,
  -- Last known agent, so a crashed daemon's orphans can be reaped on the next
  -- boot. Which of these carry it depends on where the agent ran, and the two
  -- are deliberately not one column:
  --
  --   agent_pid                 a host pid, when the agent was a child of the
  --                             daemon. Signalled only behind an os.uptime()
  --                             fence, because pids are recycled across a reboot.
  --   container_id +            a process group inside that container's own PID
  --   agent_pgid +              namespace, which is a different number space.
  --   container_started_at      Fenced by the container's StartedAt instead:
  --                             measured 2026-07-30, a `docker restart` reset the
  --                             namespace (a fresh pid was 309 before and 15
  --                             after) while host uptime did not move at all, so
  --                             the host fence cannot see it.
  --
  -- Exactly one group is non-NULL. Stored in one column the two would be
  -- indistinguishable, and the cost of confusing them is SIGKILL to whichever
  -- process now holds that number.
  agent_pid        INTEGER,
  container_id     TEXT,
  agent_pgid       INTEGER,
  container_started_at INTEGER,

  status           TEXT    NOT NULL,   -- last derived status; informational, never authoritative
  exit_json        TEXT,               -- SessionExit as JSON, NULL while live
  turn_counter     INTEGER NOT NULL DEFAULT 0,
  last_event_at    INTEGER,

  -- Persisted so looksLikeOurs() still recognises its own ids after a restart,
  -- and answers "that was settled and forgotten" rather than the much worse "no
  -- such thing on this session".
  --
  -- These count *every* parked question, not only permissions: perm-N-salt and
  -- elic-N-salt are minted from the same counter, because the question the salt
  -- answers ("is this id from this session's this life") is identical for both
  -- and the prefix already separates the two spaces. A second pair would have
  -- meant a second column, i.e. a migrate() ALTER, to buy gaps in each kind's
  -- numbering that nothing reads as a count.
  --
  -- The column names are therefore stale, and stay so on purpose: SQLite cannot
  -- rename a column without rewriting the table, and this one holds every
  -- session on disk. Same trade owner_subject is left dead for, two comments
  -- down. In TypeScript they are askSeq/askSalt.
  perm_seq         INTEGER NOT NULL DEFAULT 0,
  perm_salt        TEXT    NOT NULL DEFAULT '',

  -- Why the daemon permanently stopped trying to put an agent back on this
  -- session. NULL — the value every row starts with — means it is still worth
  -- trying, which is what almost every session deserves for ever.
  --
  -- The one exception to retry state living in memory. Everything else the pass
  -- learns (a timeout, an unreachable mount, an agent that is not signed in) is
  -- deliberately forgotten across a restart, because a restart is new
  -- information. This is written only when the *agent* says it no longer holds
  -- the conversation, which is a fact about its disk that no restart of ours
  -- changes -- and which was costing three agent spawns per dead session on
  -- every boot before it was written down. See resumeGiveUpPersists().
  --
  -- Also here rather than only in migrate(), because this file creates the
  -- table on a fresh database and migrate() only ever adds to an existing one.
  resume_gave_up   TEXT,

  -- Monotonic floors for the event store. A session whose events were pruned
  -- would otherwise restart its sequence at 1, handing a resuming client
  -- different events under numbers it has already seen. See seedFloors().
  last_seq         INTEGER NOT NULL DEFAULT 0,
  dropped          INTEGER NOT NULL DEFAULT 0,

  -- Dead as of schema v6, and left here on purpose.
  --
  -- v2 added it and said "recorded, never enforced ... so that when filtering is
  -- wanted it is a query change rather than an archaeology problem". v2-v5
  -- enforced it: one daemon answered for several people and every read path
  -- filtered on this column. v6 stopped, because the daemon serves one person
  -- again. Nothing reads or writes it; new rows leave it NULL.
  --
  -- Not removed, and the asymmetry with the credential tables is deliberate:
  -- SQLite cannot drop a column without copy-drop-rename of the whole table, and
  -- `sessions` holds every transcript on disk. Risking all of that to reclaim one
  -- nullable column per row is a bad trade. The credential tables were rewritten
  -- because they are small and hold secrets.
  owner_subject    TEXT,

  -- What this session is called, and whether it is kept at the top of the list.
  --
  -- Added in schema v5, same two-places rule as owner_subject above: fresh
  -- databases get them here, existing ones from the guarded ALTER in migrate().
  --
  -- These are the only columns on this table that are *meant* to change after
  -- creation, so unlike agent and created_at they are named in the upsert's DO
  -- UPDATE clause.
  --
  -- NULL title means never named — deliberately not '', so a client renders its
  -- own fallback rather than an empty header. The first prompt fills it in once;
  -- a manual rename leaves it non-null and therefore wins for ever.
  --
  -- `pinned` carries a DEFAULT where owner_subject above deliberately does not:
  -- SQLite refuses ADD COLUMN ... NOT NULL without one, and 0 is the honest value
  -- here because nothing that predates the column was ever pinned. NULL was the
  -- honest value for an owner nobody recorded, which is why that one never had a
  -- default.
  title            TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0,

  -- Whether somebody chose ultracode for this session, and NULL for nobody has.
  --
  -- Nullable on owner_subject's grounds rather than pinned's: there is no honest
  -- default. "Never chosen" follows REEMOAT_CLAUDE_ULTRACODE at every launch,
  -- "chosen off" outranks it for ever, and a 0 that meant both would make every
  -- session that predates this column permanently disagree with the machine's own
  -- setting. Also in the DO UPDATE clause, being one of the few things about a
  -- session that is meant to change after creation.
  ultracode        INTEGER,

  -- The SessionWorkspace record. The denormalized columns beside it exist so
  -- "which worktrees do I own" is one query rather than N blob parses.
  workspace_json   TEXT    NOT NULL,
  workspace_mode   TEXT    NOT NULL,
  workspace_root   TEXT    NOT NULL,
  workspace_branch TEXT,
  workspace_base   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);

-- Column order is load-bearing. `payload` is last so SQLite's record decoder can
-- stop before it: eviction and startup read seq/ts/bytes for every row in a
-- session, and must not fault in the overflow pages of a 128 KiB diff just to
-- answer "how big was it".
--
-- There is deliberately no foreign key to `sessions`. It would buy a cascade we
-- can write as one extra DELETE, and cost an index probe on every INSERT — on
-- the agent's synchronous emit path.
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  -- estimateBytes() of the stored payload, NOT length(payload). That is the
  -- currency the per-session bound is denominated in, and the one server.ts
  -- independently re-derives for its outbound queue. Using JSON length here
  -- would silently redefine what "8 MiB per session" means.
  bytes      INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- ⚠ **There is deliberately no covering index for `loadCounters`, and it was
-- tried.** `(session_id, seq, bytes)` does make the boot aggregate answerable
-- without touching the table — measured, 400 000 events over 554 MB went from
-- 102ms to 25ms. It was taken back out because of what it costs on the other
-- side: the same 3000 appends went from 32.6ms to 47.0ms, +45%, about 4.8us an
-- event. Those 400 000 events therefore buy 77ms once per boot for ~1.9s of extra
-- insert time, on the agent's synchronous emit path.
--
-- Which is the trade refused fourteen lines above for the foreign key, and an
-- index *insert* is strictly dearer than the index *probe* declined there. The
-- premise was wrong too: `payload` being last means the record decoder stops
-- before it, so reading `bytes` never faulted in a diff's overflow pages — the
-- cost being removed was a per-row b-tree seek, not a wide scan.
--
-- If the boot aggregate ever does become the problem, the answer is not here: it
-- is to keep the counters on the `sessions` row, where `seedFloors` already floors
-- them, or to derive them per session on demand rather than for the whole table at
-- open.

-- Single row. What this machine learned at enrollment, and the only thing it
-- ever needs from a control plane.
--
-- Nothing in here expires. A public key has no expiry, which is precisely what
-- lets an enrolled daemon keep verifying tokens with the control plane switched
-- off permanently. `code_fp` is a fingerprint of the enrollment code that was
-- redeemed, not the code itself: it is what makes "restarted with the same code"
-- (do nothing) distinguishable from "restarted with a new code" (re-enroll)
-- without a separate flag anybody could set wrongly.
CREATE TABLE IF NOT EXISTS identity (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id    TEXT    NOT NULL,
  issuer        TEXT    NOT NULL,
  -- [{ kid, jwk }] — plural, so a key rotation can be in flight and this daemon
  -- can trust the old and new keys at once.
  keys_json     TEXT    NOT NULL,
  control_plane TEXT    NOT NULL,
  code_fp       TEXT    NOT NULL,
  enrolled_at   INTEGER NOT NULL,
  -- The relay tunnel credential, and where to present it. Both NULL when the
  -- control plane runs no relay, which is also the value every identity written
  -- before these columns existed carries — so "no relay" needs no second flag.
  --
  -- This is the only recoverable secret in the file. Everything else identity
  -- holds is public; a daemon needs this one to prove it is itself on a
  -- connection it makes later, which a public key cannot do.
  tunnel_key    TEXT,
  relay_url     TEXT
);

-- A pasted agent credential, keyed by agent and variable name.
--
-- v6 rekeyed this from `(owner_subject, agent, env_name)`: it used to be one
-- credential per person, and there is one person now.
--
-- It exists because the alternative is a shell on the host. Every agent
-- authenticates out of band and reads its tokens from disk, and from a phone
-- there is no terminal to run a login in — which is the whole product, not an
-- edge case. The wizard drives the CLI under a pty; this is the other path, for
-- a token minted somewhere else.
--
-- `env_name` rather than a fixed column per agent: what a credential *is* is the
-- name of the environment variable the CLI reads it from (`CLAUDE_CODE_OAUTH_TOKEN`,
-- `KIMI_API_KEY`, `CODEX_API_KEY`), and that is per agent and liable to grow —
-- codex was the third and this table did not move. Storing the name beside the
-- value keeps `agentEnv` — which merges these at spawn — from having to know any
-- of them.
--
-- The secret is stored in the clear, and that is the same posture as the rest of
-- this file: it already holds every transcript, and `identity.tunnel_key`
-- alongside. The protection is the 0700 directory and the 0600 file, which is
-- also why the directory mode is chmodded rather than only the database — SQLite
-- writes `-wal` and `-shm` beside it on its own schedule.
--
-- Keyed by (agent, env_name) since schema v6. It used to carry an owner as well,
-- and dropping that is the one migration in this file that rewrites a table —
-- see migrateCredentialsToV6, and note that this CREATE is a no-op against an
-- existing v5 table, so the rewrite there is what actually moves it.
--
-- Retention: `prune()` deletes a row whose `updated_at` predates the session
-- horizon **and** only when no sessions remain at all. Both conditions, because
-- either alone is wrong — age on its own would delete a working credential, since
-- `updated_at` moves only when a new one is pasted, and "nothing left" on its own
-- would delete the token of somebody who pasted it before starting their first
-- session, which is the flow the UI encourages. Without any sweep at all a
-- plaintext token outlives everything, and this daemon can never hear about a
-- revocation.
--
-- A new *table*, so `schema.sql` alone is enough — `migrate()` exists only for
-- new columns on tables that already exist.
CREATE TABLE IF NOT EXISTS agent_credentials (
  agent         TEXT    NOT NULL,
  env_name      TEXT    NOT NULL,
  secret        TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (agent, env_name)
);


-- Files staged for a prompt, and the accounting that bounds them.
--
-- The bytes live under the upload root (`~/.reemoat/uploads` by default), one
-- directory per upload; this table is the index. **The row is the commit point**:
-- bytes on disk with no row here are an aborted or interrupted upload and are
-- swept, and a row whose directory has gone is dropped rather than served.
--
-- On disk rather than in memory, and the argument is *accounting* rather than
-- describability. A `prompt` event carries name/mime/bytes, so a transcript can
-- describe an attachment from the log alone — an in-memory registry in
-- `agentauth.ts`'s shape would pass that test. What it fails is the per-session
-- byte budget: a restart would reset every total to zero, and a daemon restart is
-- the ordinary outcome of `deploy.sh`, so one session could write the whole quota
-- again after every one. `agentauth.ts` gets away with memory because a pty dies
-- with its parent. A file does not.
--
-- `consumed_at` is NULL until a prompt names the upload, and it selects which
-- retention applies: an unconsumed file is somebody who attached and walked away,
-- and dies on its own TTL; a consumed one has no TTL and lives until its session
-- row is pruned. That is the only lifetime that matches "this conversation still
-- exists" — keying it on the `prompt` event would delete files while the session
-- is open, because the log evicts a *prefix*.
--
-- No foreign key to `sessions`, the same answer `events` gives: `prune()` deletes
-- orphans in the same transaction, and `PRAGMA foreign_keys` is off by design.
--
-- A new *table*, so `schema.sql` alone is enough and `SCHEMA_VERSION` stays 6 —
-- `migrate()` exists only for new columns on tables that already exist. Leaving
-- the version alone is deliberate rather than lazy: `refuseNewerSchema` throws on
-- a file stamped newer than the running build, so a bump would turn every
-- rollback into a daemon that will not start, to buy nothing.
CREATE TABLE IF NOT EXISTS uploads (
  session_id  TEXT    NOT NULL,
  upload_id   TEXT    NOT NULL,
  -- The stored name: sanitized, a single path segment. Never what was sent.
  name        TEXT    NOT NULL,
  -- What was sent, echoed back once so a client can say "we saved it as …".
  orig_name   TEXT    NOT NULL,
  -- As the client declared it. Never re-derived, and never echoed on a download.
  mime        TEXT,
  -- Counted while reading the body, never taken from Content-Length.
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (session_id, upload_id)
);

CREATE INDEX IF NOT EXISTS idx_uploads_created_at ON uploads (created_at);

-- Single row. Exists so a second daemon pointed at this file refuses to start
-- rather than interleaving sequence numbers with the first one and driving every
-- append in both processes into the degradation path.
CREATE TABLE IF NOT EXISTS daemon (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT    NOT NULL,
  pid         INTEGER NOT NULL,
  started_at  INTEGER NOT NULL
);

-- Plugins installed on this machine.
--
-- A new *table* again, so `schema.sql` alone is enough and `SCHEMA_VERSION` stays
-- 6, for the reason the `uploads` comment above already gives in full: a bump
-- turns every rollback into a daemon that will not start, to buy nothing.
--
-- One row per plugin rather than one per version, and that is the update story
-- rather than a space saving: an update *replaces* this row, and the only thing
-- that survives it is `plugin_data`, which is keyed on the id below. Two rows
-- would make "which version is installed" a query with an answer that can be two.
--
-- `manifest_json` is the validated manifest, stored whole rather than exploded
-- into columns. It is read back through `parseManifest` on every open — so a row
-- written by a newer build whose manifest this one cannot validate is refused as
-- a plugin rather than half-understood as a set of columns, which is what a
-- column per field would silently produce.
CREATE TABLE IF NOT EXISTS plugins (
  id            TEXT PRIMARY KEY,
  version       TEXT    NOT NULL,
  manifest_json TEXT    NOT NULL,
  -- Switched off by a person, and it survives an update: re-enabling somebody's
  -- disabled plugin because they updated it would be this daemon deciding
  -- something on their behalf.
  enabled       INTEGER NOT NULL DEFAULT 1,
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- The archive's filename. A forensic trail; nothing reads it for a decision.
  source        TEXT
);

-- What a plugin has put here.
--
-- **Keyed on the plugin's id and never on its version**, which is the whole of
-- what makes an update an update: a board keeps its cards across 0.1.0 → 0.2.0
-- because no part of this key mentions a version. Dropped only when the plugin is
-- uninstalled — a board whose cards outlive the board is litter nothing collects.
--
-- A table rather than a JSON blob on the `plugins` row, for the bound rather than
-- for the shape: the per-plugin byte and key ceilings are enforced by counting
-- rows, and a blob makes "how many keys does this plugin hold" a parse.
CREATE TABLE IF NOT EXISTS plugin_data (
  plugin_id  TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  -- JSON, serialized on the host side so the byte the quota counts is the byte
  -- that lands here.
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
