-- ============================================================================
-- DexterOS — D1 schema
--
-- You normally do NOT need to run this by hand: the Worker creates the schema
-- automatically on the first request (see src/lib/schema.js). It is provided so
-- you can create the tables yourself, inspect them, or run migrations:
--
--   wrangler d1 execute DB --remote --file=./schema.sql
--   wrangler d1 execute DB --local  --file=./schema.sql --persist-to .wrangler/state
--
-- Every business table carries tenant_id; all API queries are scoped by the
-- tenant of the signed-in session.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  join_code     TEXT    NOT NULL UNIQUE,
  plan          TEXT    NOT NULL DEFAULT 'pro',
  status        TEXT    NOT NULL DEFAULT 'active',
  allow_join    INTEGER NOT NULL DEFAULT 1,
  max_users     INTEGER NOT NULL DEFAULT 50,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',    -- user | admin | owner
  status        TEXT    NOT NULL DEFAULT 'active',  -- active | disabled
  avatar_type   TEXT    NOT NULL DEFAULT 'letter',  -- letter | emoji | image
  avatar_value  TEXT,
  title         TEXT,
  phone         TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

CREATE TABLE IF NOT EXISTS apps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  icon_type     TEXT    NOT NULL DEFAULT 'emoji',   -- emoji | image | letter
  icon_value    TEXT,
  icon_bg       TEXT,
  category      TEXT    NOT NULL DEFAULT 'General',
  description   TEXT,
  embed_mode    TEXT    NOT NULL DEFAULT 'auto',    -- auto | inline | external
  sort_order    INTEGER NOT NULL DEFAULT 100,
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  is_visible    INTEGER NOT NULL DEFAULT 1,
  is_system     INTEGER NOT NULL DEFAULT 0,
  is_pinned     INTEGER NOT NULL DEFAULT 0,
  open_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_tenant ON apps(tenant_id, is_enabled, is_visible, sort_order);

CREATE TABLE IF NOT EXISTS wallpapers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  description   TEXT,
  kind          TEXT    NOT NULL DEFAULT 'image',   -- image | css
  value         TEXT    NOT NULL,
  thumb         TEXT,
  storage_key   TEXT,                               -- R2 object key when uploaded
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wallpapers_tenant ON wallpapers(tenant_id, is_enabled);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id               INTEGER PRIMARY KEY,
  wallpaper_id          INTEGER,
  accent                TEXT    NOT NULL DEFAULT '#2563eb',
  theme                 TEXT    NOT NULL DEFAULT 'dark',
  taskbar_align         TEXT    NOT NULL DEFAULT 'center',
  icon_size             TEXT    NOT NULL DEFAULT 'medium',
  show_labels           INTEGER NOT NULL DEFAULT 1,
  reduced_transparency  INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  tenant_id   INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_usage (
  user_id        INTEGER NOT NULL,
  app_id         INTEGER NOT NULL,
  open_count     INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT,
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL,
  user_id     INTEGER,
  actor       TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS embed_cache (
  url         TEXT PRIMARY KEY,
  embeddable  INTEGER,
  reason      TEXT,
  status_code INTEGER,
  checked_at  TEXT NOT NULL
);

-- Deployment configuration lives in the database, so nothing about your
-- Cloudflare setup is hard-coded in the source.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-isolate rate limiting is not enough on serverless; these counters are shared.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
