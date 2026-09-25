-- Re-applied on every open: every statement must be idempotent.

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  agent            TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  agent_session_id TEXT,
  -- Exactly one group is non-NULL: a host pid and a container pgid are different number spaces.
  agent_pid        INTEGER,
  container_id     TEXT,
  agent_pgid       INTEGER,
  container_started_at INTEGER,

  status           TEXT    NOT NULL,
  exit_json        TEXT,
  turn_counter     INTEGER NOT NULL DEFAULT 0,
  last_event_at    INTEGER,

  -- perm_* counts every parked question; renaming would rewrite the table.
  perm_seq         INTEGER NOT NULL DEFAULT 0,
  perm_salt        TEXT    NOT NULL DEFAULT '',

  resume_gave_up   TEXT,

  last_seq         INTEGER NOT NULL DEFAULT 0,
  dropped          INTEGER NOT NULL DEFAULT 0,

  -- Dead since schema v6; kept because dropping a column rewrites the whole table.
  owner_subject    TEXT,

  title            TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0,

  rank             REAL,

  ultracode        INTEGER,

  agent_state_json TEXT,

  workspace_json   TEXT    NOT NULL,
  workspace_mode   TEXT    NOT NULL,
  workspace_root   TEXT    NOT NULL,
  workspace_branch TEXT,
  workspace_base   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at);

-- Column order is load-bearing: payload last, so reading seq/ts/bytes stops before it.
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS identity (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id    TEXT    NOT NULL,
  issuer        TEXT    NOT NULL,
  keys_json     TEXT    NOT NULL,
  control_plane TEXT    NOT NULL,
  code_fp       TEXT    NOT NULL,
  enrolled_at   INTEGER NOT NULL,
  tunnel_key    TEXT,
  relay_url     TEXT
);

-- No retention by design (Q7.124); secrets in the clear, protected by the 0700 directory and 0600 file.
CREATE TABLE IF NOT EXISTS agent_credentials (
  agent         TEXT    NOT NULL,
  env_name      TEXT    NOT NULL,
  secret        TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (agent, env_name)
);


-- The row is the commit point; NULL consumed_at is staged and expires, otherwise it lives as long as its session.
CREATE TABLE IF NOT EXISTS uploads (
  session_id  TEXT    NOT NULL,
  upload_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  orig_name   TEXT    NOT NULL,
  mime        TEXT,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (session_id, upload_id)
);

CREATE INDEX IF NOT EXISTS idx_uploads_created_at ON uploads (created_at);

CREATE TABLE IF NOT EXISTS daemon (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT    NOT NULL,
  pid         INTEGER NOT NULL,
  started_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugins (
  id            TEXT PRIMARY KEY,
  version       TEXT    NOT NULL,
  manifest_json TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  source        TEXT
);

CREATE TABLE IF NOT EXISTS plugin_data (
  plugin_id  TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);


-- No retention (Q7.124); passed over ACP, never merged into an environment.
CREATE TABLE IF NOT EXISTS system_credentials (
  system        TEXT    NOT NULL PRIMARY KEY,
  secret        TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL
);


-- harness and system are validated on read, model never (Q7.31).
CREATE TABLE IF NOT EXISTS custom_agents (
  id            TEXT    NOT NULL PRIMARY KEY,
  name          TEXT    NOT NULL,
  harness       TEXT    NOT NULL,
  system        TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS agent_strip (
  kind          TEXT    NOT NULL,
  ref           TEXT    NOT NULL,
  rank          INTEGER NOT NULL,
  hidden        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, ref)
);


-- At most one live row, enforced by an index migrate() creates after the lock, not here.
CREATE TABLE IF NOT EXISTS machine_keys (
  kth         TEXT PRIMARY KEY,
  public_key  TEXT    NOT NULL,
  private_key TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);


-- Capabilities another machine's Authority minted for this one's agents to reach it (Q7.150). Replaced whole by the owner's app.
CREATE TABLE IF NOT EXISTS peer_links (
  id                TEXT PRIMARY KEY,
  target_machine_id TEXT    NOT NULL,
  target_name       TEXT    NOT NULL,
  target_key        TEXT    NOT NULL,
  relay_url         TEXT,
  token             TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_error        TEXT,
  last_error_at     INTEGER
);


-- Messages for a linked machine that was offline; this daemon's own, since the relay may queue nothing (Q7.150).
CREATE TABLE IF NOT EXISTS peer_outbox (
  id                TEXT PRIMARY KEY,
  sender_session    TEXT    NOT NULL,
  link_id           TEXT    NOT NULL,
  target_machine_id TEXT    NOT NULL,
  target_name       TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  next_at           INTEGER NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);
