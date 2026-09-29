/**
 * DexterOS — account routes (/api/me): profile, avatar, password, desktop
 * preferences, wallpaper choice, session management and account deletion.
 */
import { HttpError, isValidEmail, normalizeEmail, nowIso, passwordProblem, safeAssetRef, str, clampInt } from '../lib/util.js';
import { readJson } from '../lib/http.js';
import { destroyUserSessions, hashPassword, isAdmin, verifyPassword } from '../lib/auth.js';
import { presentSettings, presentUser } from '../lib/presenters.js';
import { ensureUserSettings, getWallpaperFor } from '../lib/wallpaper.js';
import { logActivity } from '../lib/activity.js';
import { storeUpload } from '../lib/media.js';

const ACCENT_RE = /^#[0-9a-f]{6}$/i;

const refreshUser = (db, id) => db.first('SELECT * FROM users WHERE id = ?', [id]);

export const routes = {
  'GET /': {
    auth: 'user',
    handler: async ({ db, session }) => ({
      body: { user: presentUser(session.user), settings: presentSettings(await ensureUserSettings(db, session.user.id)) },
    }),
  },

  'PATCH /': {
    auth: 'user',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const patch = {};

      if (body.name !== undefined) {
        const name = str(body.name, 80);
        if (name.length < 2) throw new HttpError(400, 'Name must be at least 2 characters.');
        patch.name = name;
      }
      if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        if (!isValidEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
        const clash = await db.first('SELECT id FROM users WHERE tenant_id = ? AND LOWER(email) = ? AND id <> ?', [session.user.tenant_id, email, session.user.id]);
        if (clash) throw new HttpError(409, 'Another member of this workspace already uses that email.');
        patch.email = email;
      }
      if (body.title !== undefined) patch.title = str(body.title, 80);
      if (body.phone !== undefined) patch.phone = str(body.phone, 40);
      if (body.avatar && typeof body.avatar === 'object') {
        const type = str(body.avatar.type, 10) || 'letter';
        if (!['letter', 'emoji', 'image'].includes(type)) throw new HttpError(400, 'Unsupported avatar type.');
        const value = str(body.avatar.value, 300) || null;
        if (type === 'image' && value && !safeAssetRef(value)) throw new HttpError(400, 'Avatar image must be an uploaded file or a valid URL.');
        patch.avatar_type = type;
        patch.avatar_value = value;
      }

      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`, [...Object.values(patch), nowIso(), session.user.id]);
      const updated = await refreshUser(db, session.user.id);
      await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: updated.email, action: 'user.updated', detail: 'Updated their profile' });
      return { body: { user: presentUser(updated) } };
    },
  },

  'POST /avatar': {
    auth: 'user',
    handler: async ({ request, db, env, session, settings }) => {
      const upload = await storeUpload(env, request, {
        tenantId: session.user.tenant_id,
        kind: 'avatars',
        maxBytes: Number(settings.upload_max_bytes),
      });
      await db.run('UPDATE users SET avatar_type = ?, avatar_value = ?, updated_at = ? WHERE id = ?', ['image', upload.url, nowIso(), session.user.id]);
      const updated = await refreshUser(db, session.user.id);
      await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: updated.email, action: 'user.updated', detail: 'Changed profile photo' });
      return { status: 201, body: { user: presentUser(updated), storage_key: upload.key, size: upload.size } };
    },
  },

  'PATCH /password': {
    auth: 'user',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const current = String(body.current_password ?? '');
      const next = String(body.new_password ?? '');
      const row = await db.first('SELECT password_hash FROM users WHERE id = ?', [session.user.id]);
      if (!(await verifyPassword(current, row.password_hash))) throw new HttpError(400, 'Your current password is incorrect.');
      const problem = passwordProblem(next);
      if (problem) throw new HttpError(400, problem);
      await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [await hashPassword(next), nowIso(), session.user.id]);
      await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: session.user.email, action: 'user.password_changed', detail: 'Changed their password' });
      return { body: { ok: true, message: 'Password updated.' } };
    },
  },

  'PATCH /preferences': {
    auth: 'user',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      await ensureUserSettings(db, session.user.id);
      const patch = {};

      if (body.wallpaper_id !== undefined) {
        if (body.wallpaper_id === null || body.wallpaper_id === '') {
          patch.wallpaper_id = null;
        } else {
          const id = clampInt(body.wallpaper_id, 1, 2 ** 31, null);
          if (!id) throw new HttpError(400, 'Invalid wallpaper.');
          const available = await db.first('SELECT id FROM wallpapers WHERE id = ? AND tenant_id = ? AND is_enabled = 1', [id, session.user.tenant_id]);
          if (!available) throw new HttpError(400, 'That wallpaper is not available in your workspace.');
          patch.wallpaper_id = id;
        }
      }
      if (body.accent !== undefined) {
        const accent = str(body.accent, 9);
        if (!ACCENT_RE.test(accent)) throw new HttpError(400, 'Accent must be a hex colour such as #2563eb.');
        patch.accent = accent.toLowerCase();
      }
      if (body.theme !== undefined) {
        const theme = str(body.theme, 10);
        if (!['dark', 'light'].includes(theme)) throw new HttpError(400, 'Theme must be dark or light.');
        patch.theme = theme;
      }
      if (body.taskbar_align !== undefined) {
        const align = str(body.taskbar_align, 10);
        if (!['center', 'left'].includes(align)) throw new HttpError(400, 'Taskbar alignment must be center or left.');
        patch.taskbar_align = align;
      }
      if (body.icon_size !== undefined) {
        const size = str(body.icon_size, 10);
        if (!['small', 'medium', 'large'].includes(size)) throw new HttpError(400, 'Icon size must be small, medium or large.');
        patch.icon_size = size;
      }
      if (body.show_labels !== undefined) patch.show_labels = body.show_labels ? 1 : 0;
      if (body.reduced_transparency !== undefined) patch.reduced_transparency = body.reduced_transparency ? 1 : 0;

      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
        await db.run(`UPDATE user_settings SET ${sets}, updated_at = ? WHERE user_id = ?`, [...Object.values(patch), nowIso(), session.user.id]);
      }
      const row = await ensureUserSettings(db, session.user.id);
      return { body: { settings: presentSettings(row), wallpaper: await getWallpaperFor(db, session.user.id, session.user.tenant_id) } };
    },
  },

  'POST /sessions/revoke': {
    auth: 'user',
    handler: async ({ db, session }) => {
      await destroyUserSessions(db, session.user.id);
      await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: session.user.email, action: 'user.sessions_revoked', detail: 'Signed out of all devices' });
      return { body: { ok: true, clearCookie: true, message: 'Signed out of all devices.' } };
    },
  },

  'DELETE /': {
    auth: 'user',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const password = String(body.password ?? '');
      const row = await db.first('SELECT password_hash FROM users WHERE id = ?', [session.user.id]);
      if (!(await verifyPassword(password, row.password_hash))) throw new HttpError(400, 'Enter your password to confirm account deletion.');

      if (isAdmin(session.user)) {
        const admins = await db.first(
          "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role IN ('admin','owner') AND status = 'active'",
          [session.user.tenant_id]
        );
        if ((admins?.n ?? 0) <= 1) {
          throw new HttpError(400, 'You are the only administrator of this workspace. Promote another member before deleting your account.');
        }
      }

      const user = session.user;
      await logActivity(db, { tenantId: user.tenant_id, userId: null, actor: user.email, action: 'user.deleted', detail: `Account deleted (${user.email})` });
      await destroyUserSessions(db, user.id);
      await db.run('DELETE FROM app_usage WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM user_settings WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM users WHERE id = ?', [user.id]);
      await db.run('DELETE FROM sessions WHERE token = ?', [session.token]);
      return { body: { ok: true, clearCookie: true, message: 'Your account has been deleted.' } };
    },
  },
};
