/**
 * DexterOS — schema management.
 *
 * The schema is created on demand the first time the API is used, so a fresh
 * Cloudflare deployment becomes usable without running any migration by hand.
 * It mirrors schema.sql, statement by statement, and runs against the D1 binding.
 */
import { HttpError } from './util.js';

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     name          TEXT    NOT NULL,
     slug          TEXT    NOT NULL UNIQUE,
     join_code     TEXT    NOT NULL UNIQUE,
     plan          TEXT    NOT NULL DEFAULT 'pro',
     status        TEXT    NOT NULL DEFAULT 'active',
     allow_join    INTEGER NOT NULL DEFAULT 1,
     max_users     INTEGER NOT NULL DEFAULT 50,
     created_at    TEXT    NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     tenant_id     INTEGER NOT NULL,
     name          TEXT    NOT NULL,
     email         TEXT    NOT NULL,
     password_hash TEXT    NOT NULL,
     role          TEXT    NOT NULL DEFAULT 'user',
     status        TEXT    NOT NULL DEFAULT 'active',
     avatar_type   TEXT    NOT NULL DEFAULT 'letter',
     avatar_value  TEXT,
     title         TEXT,
     phone         TEXT,
     verified      INTEGER NOT NULL DEFAULT 0,
     last_login_at TEXT,
     created_at    TEXT    NOT NULL,
     updated_at    TEXT    NOT NULL,
     UNIQUE (tenant_id, email)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
  `CREATE TABLE IF NOT EXISTS apps (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     tenant_id     INTEGER NOT NULL,
     name          TEXT    NOT NULL,
     url           TEXT    NOT NULL,
     icon_type     TEXT    NOT NULL DEFAULT 'emoji',
     icon_value    TEXT,
     icon_bg       TEXT,
     category      TEXT    NOT NULL DEFAULT 'General',
     description   TEXT,
     embed_mode    TEXT    NOT NULL DEFAULT 'auto',
     sort_order    INTEGER NOT NULL DEFAULT 100,
     is_enabled    INTEGER NOT NULL DEFAULT 1,
     is_visible    INTEGER NOT NULL DEFAULT 1,
     is_system     INTEGER NOT NULL DEFAULT 0,
     is_pinned     INTEGER NOT NULL DEFAULT 0,
     open_count    INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT    NOT NULL,
     updated_at    TEXT    NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_apps_tenant ON apps(tenant_id, is_enabled, is_visible, sort_order)',
  `CREATE TABLE IF NOT EXISTS wallpapers (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     tenant_id     INTEGER NOT NULL,
     name          TEXT    NOT NULL,
     description   TEXT,
     kind          TEXT    NOT NULL DEFAULT 'image',
     value         TEXT    NOT NULL,
     thumb         TEXT,
     storage_key   TEXT,
     is_enabled    INTEGER NOT NULL DEFAULT 1,
     is_default    INTEGER NOT NULL DEFAULT 0,
     sort_order    INTEGER NOT NULL DEFAULT 100,
     created_at    TEXT    NOT NULL,
     updated_at    TEXT    NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_wallpapers_tenant ON wallpapers(tenant_id, is_enabled)',
  `CREATE TABLE IF NOT EXISTS user_settings (
     user_id               INTEGER PRIMARY KEY,
     wallpaper_id          INTEGER,
     accent                TEXT    NOT NULL DEFAULT '#2563eb',
     theme                 TEXT    NOT NULL DEFAULT 'dark',
     taskbar_align         TEXT    NOT NULL DEFAULT 'center',
     icon_size             TEXT    NOT NULL DEFAULT 'medium',
     show_labels           INTEGER NOT NULL DEFAULT 1,
     reduced_transparency  INTEGER NOT NULL DEFAULT 0,
     updated_at            TEXT    NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token       TEXT    PRIMARY KEY,
     user_id     INTEGER NOT NULL,
     tenant_id   INTEGER NOT NULL,
     user_agent  TEXT,
     ip          TEXT,
     created_at  TEXT    NOT NULL,
     expires_at  TEXT    NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS app_usage (
     user_id        INTEGER NOT NULL,
     app_id         INTEGER NOT NULL,
     open_count     INTEGER NOT NULL DEFAULT 0,
     last_opened_at TEXT,
     PRIMARY KEY (user_id, app_id)
   )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     tenant_id   INTEGER NOT NULL,
     user_id     INTEGER,
     actor       TEXT,
     action      TEXT NOT NULL,
     detail      TEXT,
     created_at  TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS embed_cache (
     url         TEXT PRIMARY KEY,
     embeddable  INTEGER,
     reason      TEXT,
     status_code INTEGER,
     checked_at  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key          TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count        INTEGER NOT NULL
   )`,
];

export const SCHEMA_VERSION = '2';

/** True when the tables exist (cheap probe used by the status endpoint). */
export async function schemaReady(db) {
  try {
    const row = await db.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'");
    if (!row) return false;
    const version = await db.first("SELECT value FROM app_settings WHERE key = 'schema_version'").catch(() => null);
    return !!version;
  } catch {
    return false;
  }
}

/** Creates every table and records the schema version. Safe to call repeatedly. */
export async function ensureSchema(db) {
  let index = 0;
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      index += 1;
      await db.exec(statement);
    }
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('schema_version', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SCHEMA_VERSION, now]
    );
    return { created: true };
  } catch (err) {
    // The statement number turns "something is wrong" into a specific report the
    // setup wizard can show the operator.
    throw new HttpError(
      500,
      `Database initialisation failed at statement ${index}/${SCHEMA_STATEMENTS.length}: ${err.message}`,
      'SCHEMA_FAILED'
    );
  }
}

/** Everything a workspace needs to be usable: the Settings app plus starter wallpapers. */
export async function scaffoldTenant(db, tenantId) {
  const now = new Date().toISOString();
  const existing = await db.first("SELECT id FROM apps WHERE tenant_id = ? AND url = 'dexteros://settings'", [tenantId]);
  if (existing) {
    await db.run('UPDATE apps SET is_enabled = 1, is_visible = 1, is_system = 1 WHERE id = ?', [existing.id]);
  } else {
    await db.run(
      `INSERT INTO apps (tenant_id, name, url, icon_type, icon_value, icon_bg, category, description, embed_mode,
                         sort_order, is_enabled, is_visible, is_system, is_pinned, open_count, created_at, updated_at)
       VALUES (?, 'Settings', 'dexteros://settings', 'emoji', '⚙️', '#1e293b', 'System',
               'Account, personalization and workspace preferences.', 'system', 0, 1, 1, 1, 1, 0, ?, ?)`,
      [tenantId, now, now]
    );
  }

  const count = await db.first('SELECT COUNT(*) AS n FROM wallpapers WHERE tenant_id = ?', [tenantId]);
  if (!count || count.n === 0) {
    await db.run(
      `INSERT INTO wallpapers (tenant_id, name, description, kind, value, thumb, storage_key, is_enabled, is_default, sort_order, created_at, updated_at)
       VALUES (?, 'Dexter Midnight', 'Default dark gradient.', 'css', ?, NULL, NULL, 1, 1, 10, ?, ?)`,
      [
        tenantId,
        'radial-gradient(1200px 800px at 18% 8%, #1e3a8a 0%, transparent 58%), linear-gradient(160deg, #070b16 0%, #0b1226 55%, #05070f 100%)',
        now, now,
      ]
    );
    await db.run(
      `INSERT INTO wallpapers (tenant_id, name, description, kind, value, thumb, storage_key, is_enabled, is_default, sort_order, created_at, updated_at)
       VALUES (?, 'Dexter Daylight', 'Bright gradient for daylight working.', 'css', ?, NULL, NULL, 1, 0, 20, ?, ?)`,
      [
        tenantId,
        'radial-gradient(1000px 700px at 82% 0%, #dbeafe 0%, transparent 55%), linear-gradient(150deg, #f8fafc 0%, #e2e8f0 60%, #cbd5e1 100%)',
        now, now,
      ]
    );
  }
}
