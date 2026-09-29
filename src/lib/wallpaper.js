/**
 * DexterOS — wallpaper + user settings helpers.
 */
import { nowIso } from './util.js';
import { presentSettings, presentWallpaper } from './presenters.js';

export const DEFAULT_ACCENT = '#2563eb';

/** Creates the settings row for a user on first access and returns it. */
export async function ensureUserSettings(db, userId) {
  const existing = await db.first('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
  if (existing) return existing;
  const now = nowIso();
  await db.run(
    `INSERT INTO user_settings (user_id, wallpaper_id, accent, theme, taskbar_align, icon_size, show_labels, reduced_transparency, updated_at)
     VALUES (?, NULL, ?, 'dark', 'center', 'medium', 1, 0, ?)`,
    [userId, DEFAULT_ACCENT, now]
  );
  return db.first('SELECT * FROM user_settings WHERE user_id = ?', [userId]);
}

export const getSettings = (db, userId) => ensureUserSettings(db, userId);
export const serializeSettings = (row) => presentSettings(row);

/**
 * The wallpaper a user should see: their own choice when it is still available,
 * otherwise the workspace default, otherwise any active wallpaper.
 */
export async function getWallpaperFor(db, userId, tenantId) {
  const settings = await ensureUserSettings(db, userId);
  if (settings.wallpaper_id) {
    const chosen = await db.first(
      'SELECT * FROM wallpapers WHERE id = ? AND tenant_id = ? AND is_enabled = 1',
      [settings.wallpaper_id, tenantId]
    );
    if (chosen) return presentWallpaper(chosen);
  }
  const fallback = await db.first(
    'SELECT * FROM wallpapers WHERE tenant_id = ? AND is_enabled = 1 ORDER BY is_default DESC, sort_order ASC, id ASC LIMIT 1',
    [tenantId]
  );
  return fallback ? presentWallpaper(fallback) : null;
}
