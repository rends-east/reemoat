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
  -- Unique per machine by the registry's reservation, not an index: an older row may hold a duplicate until restore re-picks it.
  nickname         TEXT,
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
  relay_url     TEXT,
  root_kid      TEXT,
  root_jwk      TEXT,
  keyset_version INTEGER
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

-- A task's files and the ones staged for a task: owner_id is the task's id, or `staged` until a create or comment names it.
-- Never pruned with the sessions, which is why it is not the uploads table.
CREATE TABLE IF NOT EXISTS task_files (
  owner_id    TEXT    NOT NULL,
  upload_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  orig_name   TEXT    NOT NULL,
  mime        TEXT,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (owner_id, upload_id)
);

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


-- A sign-in a system is reached with where it takes one in place of a key. Only the access token goes anywhere but its issuer (Q7.160).
CREATE TABLE IF NOT EXISTS system_sign_ins (
  system        TEXT    NOT NULL PRIMARY KEY,
  flow          TEXT    NOT NULL,
  client_id     TEXT    NOT NULL,
  access        TEXT    NOT NULL,
  refresh       TEXT    NOT NULL,
  expires_at    INTEGER NOT NULL,
  account       TEXT,
  signed_in_by  TEXT,
  updated_at    INTEGER NOT NULL
);
-- What this machine calls itself to a sign-in provider: minted once per flow and kept through a sign-out.
CREATE TABLE IF NOT EXISTS sign_in_hosts (
  flow          TEXT    NOT NULL PRIMARY KEY,
  host_id       TEXT    NOT NULL
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


-- Keys that opened an encrypted channel here: a journal while the lock is off, the allowlist while it is on (Q1.655).
CREATE TABLE IF NOT EXISTS known_devices (
  kth         TEXT PRIMARY KEY,
  public_key  TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  label       TEXT,
  platform    TEXT,
  subject     TEXT    NOT NULL,
  ref         TEXT,
  state       TEXT    NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
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


-- Message ids another machine delivered here, kept a day so a retry that outlives a restart is still a duplicate (Q2.241).
CREATE TABLE IF NOT EXISTS peer_seen (
  source_machine_id TEXT    NOT NULL,
  message_id        TEXT    NOT NULL,
  seen_at           INTEGER NOT NULL,
  PRIMARY KEY (source_machine_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_seen_at ON peer_seen (seen_at);


-- What somebody wants done here. status never holds needs_you: that is read off the task's sessions (Q2.258).
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT    NOT NULL PRIMARY KEY,
  title         TEXT    NOT NULL,
  brief         TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  summary       TEXT,
  summary_at    INTEGER,
  summary_by    TEXT,
  agent         TEXT    NOT NULL,
  custom_agent  TEXT,
  -- Who holds it in the backlog, as an index into TASK_ASSIGNEES: 0 nobody, 1 the agent named, 2 its person (Q2.262).
  assigned      INTEGER NOT NULL DEFAULT 0,
  cwd           TEXT    NOT NULL,
  key           TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- A session works on one task, so the session is the key and attaching it again moves it.
CREATE TABLE IF NOT EXISTS task_sessions (
  session_id    TEXT    NOT NULL PRIMARY KEY,
  task_id       TEXT    NOT NULL,
  attached_at   INTEGER NOT NULL
);
-- A task's history: each move, run, stop and verdict, under the board revision it happened at (Q2.264).
CREATE TABLE IF NOT EXISTS task_events (
  task_id       TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  payload       TEXT    NOT NULL,
  PRIMARY KEY (task_id, seq)
);
-- A task's feed: the agent's questions as windows on its sessions, its stops and reports, and its person's comments (Q2.265).
CREATE TABLE IF NOT EXISTS task_comments (
  task_id       TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  at            INTEGER NOT NULL,
  payload       TEXT    NOT NULL,
  PRIMARY KEY (task_id, id)
);
-- What is left of a task another machine took, so a reader can follow it there.
CREATE TABLE IF NOT EXISTS task_tombstones (
  id            TEXT    NOT NULL PRIMARY KEY,
  epoch         INTEGER NOT NULL,
  moved_to      TEXT    NOT NULL,
  at            INTEGER NOT NULL,
  workdir       TEXT,
  branch        TEXT
);
-- The account's board, as the YAML it was written in, one row per revision.
CREATE TABLE IF NOT EXISTS board_configs (
  revision      INTEGER NOT NULL PRIMARY KEY,
  hash          TEXT    NOT NULL,
  text          TEXT    NOT NULL,
  at            INTEGER NOT NULL
);
