/**
 * DexterOS — runtime configuration store.
 *
 * Configuration lives in the database (table `app_settings`), not in source
 * files. Environment variables only provide the *initial* values for a brand new
 * deployment; once the setup wizard has run, everything is editable from the
 * admin console. Nothing about the Cloudflare account (database id, bucket,
 * token) is ever written into the repository — the app only sees binding names.
 */
import { clampInt, nowIso, str } from './util.js';

const CACHE_TTL_MS = 5000;
let cache = { value: null, at: 0 };

export function invalidateSettings() {
  cache = { value: null, at: 0 };
}

/** Defaults come from the deployment environment so a fresh install is configurable. */
export function envDefaults(env = {}) {
  return {
    service_name: str(env.SERVICE_NAME, 60) || 'DexterOS',
    registration_mode: str(env.REGISTRATION_MODE, 10).toLowerCase() === 'open' ? 'open' : 'closed',
    max_users_per_tenant: String(clampInt(env.MAX_USERS_PER_TENANT, 1, 100000, 50)),
    max_tenants: String(clampInt(env.MAX_TENANTS, 1, 100000, 50)),
    upload_max_bytes: String(clampInt(env.UPLOAD_MAX_BYTES, 65536, 100 * 1024 * 1024, 6 * 1024 * 1024)),
    embed_probe_enabled: 'true',
    support_email: str(env.SUPPORT_EMAIL, 190),
    initialized_at: '',
  };
}

export async function loadSettings(db, env = {}) {
  if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const defaults = envDefaults(env);
  let stored = {};
  try {
    const rows = await db.all('SELECT key, value FROM app_settings');
    stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    stored = {};
  }
  const value = { ...defaults, ...stored };
  value.max_users_per_tenant = String(clampInt(value.max_users_per_tenant, 1, 100000, 50));
  value.max_tenants = String(clampInt(value.max_tenants, 1, 100000, 50));
  value.upload_max_bytes = String(clampInt(value.upload_max_bytes, 65536, 100 * 1024 * 1024, 6 * 1024 * 1024));
  value.registration_mode = value.registration_mode === 'open' ? 'open' : 'closed';
  value.initialized = Boolean(value.initialized_at);
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(db, patch) {
  const now = nowIso();
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  for (const [key, value] of entries) {
    await db.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value ?? ''), now]
    );
  }
  invalidateSettings();
  return entries.length;
}

export async function getSetting(db, key, fallback = null) {
  const row = await db.first('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
