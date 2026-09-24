-- Re-applied on every open: every statement must be idempotent. A new column goes through store.ts migrate(),
-- additions only, and CP_SCHEMA_VERSION does not move for it (a bump crash-loops a rolled-back image).

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- u_<hex>
  name        TEXT    NOT NULL UNIQUE,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER,
  -- Written only when the person chooses a password; admin-issued and bootstrap passwords leave it alone.
  password_changed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_name_folded ON users (lower(name));

-- Only a hash is stored; `prefix` is clear text for an indexed lookup. No route mints a key for anyone but the caller.
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,           -- ak_<hex>
  user_id    TEXT    NOT NULL,
  prefix     TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

-- No row means the account predates passwords and may set a first one without a current one.
CREATE TABLE IF NOT EXISTS user_passwords (
  user_id    TEXT PRIMARY KEY,
  hash       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A bearer token in an Authorization header, never a cookie: CORS allows * only because no credential is ambient.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,         -- s_<hex>
  user_id      TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Absolute and never extended; nothing authenticates on last_seen_at.
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  device_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_prefix ON user_sessions (prefix);
-- The index on device_id lives in store.ts migrate(): this file runs before migrate adds the column.
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id, created_at);

-- Caller-supplied, so nothing may ever authorize on these.
CREATE TABLE IF NOT EXISTS user_session_origins (
  session_id TEXT PRIMARY KEY,
  ip         TEXT,
  user_agent TEXT
);

-- An installation of the app: not a secret and not an authorization subject (relay/authorize.ts must not read it).
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,          -- dv_<hex>
  user_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  -- X25519 public key (base64url), named in every capability minted for this device.
  public_key TEXT,
  key_set_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id, created_at);

-- Ownership, separate from grants. created_at is when this user acquired the machine; quota.ts ranks on it.
CREATE TABLE IF NOT EXISTS machine_owners (
  machine_id TEXT PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_owners_label ON machine_owners (user_id, label);
CREATE INDEX IF NOT EXISTS idx_machine_owners_user ON machine_owners (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_machine_owners_rank ON machine_owners (user_id, created_at, machine_id);

CREATE TABLE IF NOT EXISTS machines (
  id          TEXT PRIMARY KEY,          -- m_<hex>
  name        TEXT    NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  enrolled_at INTEGER,
  -- Stops new tokens being minted; issued tokens stay valid until they expire.
  revoked_at  INTEGER
  -- machine_key, machine_key_set_at: added by store.ts migrate(). Pinned on first announcement; a different later key is refused.
);

CREATE INDEX IF NOT EXISTS idx_machines_created_at ON machines (created_at);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);

CREATE TABLE IF NOT EXISTS grants (
  user_id    TEXT    NOT NULL,
  machine_id TEXT    NOT NULL,
  scopes     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_id)
);

CREATE INDEX IF NOT EXISTS idx_grants_created_at ON grants (created_at);

CREATE INDEX IF NOT EXISTS idx_grants_machine ON grants (machine_id, created_at);

-- Retired rather than deleted so a rotation can overlap: a daemon never re-fetches keys.
CREATE TABLE IF NOT EXISTS signing_keys (
  kid         TEXT PRIMARY KEY,          -- k_<hex>
  private_pem TEXT    NOT NULL,
  public_jwk  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);

-- Single-use is enforced by the conditional UPDATE on used_at IS NULL.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id         TEXT PRIMARY KEY,           -- ec_<hex>
  code_hash  TEXT    NOT NULL UNIQUE,
  machine_id TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_from  TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrollment_codes_machine ON enrollment_codes (machine_id);

-- The secret a daemon proves itself with when dialling the relay; retired, not deleted, on re-enrollment.
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

-- A missing row means "fall back to the environment", so nothing seeds it. No route returns smtp.password.
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

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
  -- The confirming address, or a burn reason: 'superseded', 'name_taken', 'email_taken'.
  used_from     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_name ON pending_registrations (name_folded, used_at);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_email ON pending_registrations (email_folded, used_at);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires ON pending_registrations (expires_at);

-- Uniqueness applies only to verified rows, so an unverified claim reserves nothing.
CREATE TABLE IF NOT EXISTS user_emails (
  user_id      TEXT PRIMARY KEY,
  email        TEXT    NOT NULL,
  email_folded TEXT    NOT NULL,
  -- NULL means claimed and unproved: POST /v1/forgot will not mail it.
  verified_at  INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_folded ON user_emails (email_folded);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_verified
  ON user_emails (email_folded) WHERE verified_at IS NOT NULL;

-- Every claim must match user_emails.email_folded, so a link for an old address cannot verify a new one.
CREATE TABLE IF NOT EXISTS user_email_tokens (
  id           TEXT PRIMARY KEY,           -- ut_<hex>
  user_id      TEXT    NOT NULL,
  -- 'verify' | 'reset'. An invitation is a 'reset' for an account with no password yet.
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

-- `body` holds a live one-time link: cleared with sent_at, kept on failure only until not_after.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         TEXT PRIMARY KEY,             -- mo_<hex>
  to_address TEXT    NOT NULL,
  to_folded  TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  body       TEXT,
  created_at INTEGER NOT NULL,
  not_after  INTEGER NOT NULL,
  -- Doubles as the claim lease, so a crashed send becomes eligible again.
  next_at    INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER,
  failed_at  INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mail_outbox_ready
  ON mail_outbox (next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_outbox_created ON mail_outbox (created_at);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_notice ON mail_outbox (to_folded, kind, created_at);

-- A row is the obligation to replace the password; cleared with the new hash, not by enable.
CREATE TABLE IF NOT EXISTS password_obligations (
  user_id    TEXT PRIMARY KEY,
  reason     TEXT    NOT NULL,             -- 'admin_created'
  created_at INTEGER NOT NULL
);

-- No row means the instance default; 0 is a real limit. Capped by MAX_MACHINES_PER_USER.
CREATE TABLE IF NOT EXISTS user_machine_limits (
  user_id      TEXT PRIMARY KEY,
  max_machines INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT
);

-- Authorizes POST /v1/provision only. At most one is live: minting retires the previous row in the same transaction.
CREATE TABLE IF NOT EXISTS provisioning_keys (
  id         TEXT PRIMARY KEY,           -- pk_<hex>
  prefix     TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provisioning_keys_prefix ON provisioning_keys (prefix);

-- Tunnel presence, written only by the relay, best-effort; read with a staleness window since a killed relay leaves rows.
CREATE TABLE IF NOT EXISTS relay_tunnels (
  machine_id       TEXT PRIMARY KEY,
  relay_id         TEXT    NOT NULL,
  connected_at     INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  requests_proxied INTEGER NOT NULL DEFAULT 0,
  active_streams   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_relay_tunnels_relay ON relay_tunnels (relay_id, last_seen_at);

-- A relay refuses to start while a live other process holds its relay_id: two on one slot sweep each other.
CREATE TABLE IF NOT EXISTS relay_instances (
  relay_id     TEXT PRIMARY KEY,
  nonce        TEXT    NOT NULL,
  claimed_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_last_seen (
  machine_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
);
