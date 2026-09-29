/**
 * DexterOS — admin console routes (/api/admin).
 * Every query is scoped to the workspace of the signed-in administrator, so one
 * workspace can never read or change another workspace's data.
 */
import {
  HttpError, clampInt, isValidEmail, normalizeEmail, nowIso, passwordProblem, safeAssetRef, safeUrl, str,
} from '../lib/util.js';
import { readJson } from '../lib/http.js';
import { destroyUserSessions, hashPassword, isAdmin } from '../lib/auth.js';
import { presentApp, presentSettings, presentTenant, presentUser, presentWallpaper } from '../lib/presenters.js';
import { ensureUserSettings } from '../lib/wallpaper.js';
import { logActivity } from '../lib/activity.js';
import { storeUpload } from '../lib/media.js';
import { saveSettings } from '../lib/settings.js';

const ACCENT_RE = /^#[0-9a-f]{6}$/i;
const tenantId = (session) => session.user.tenant_id;

/* ------------------------------------------------------------------ helpers */

async function assertNotLastAdmin(db, tenant, target, action) {
  if (!isAdmin(target)) return;
  const row = await db.first(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role IN ('admin','owner') AND status = 'active'",
    [tenant]
  );
  if ((row?.n ?? 0) <= 1 && target.status === 'active') {
    throw new HttpError(400, `You cannot ${action} the last active administrator of this workspace.`);
  }
}

const findApp = (db, tenant, id) =>
  db.first('SELECT * FROM apps WHERE id = ? AND tenant_id = ?', [Number(id), tenant]);

const findWallpaper = (db, tenant, id) =>
  db.first('SELECT * FROM wallpapers WHERE id = ? AND tenant_id = ?', [Number(id), tenant]);

function validateIcon(body, fallback = {}) {
  const type = str(body.icon_type, 10) || fallback.icon_type || 'emoji';
  if (!['emoji', 'image', 'letter'].includes(type)) throw new HttpError(400, 'Icon type must be emoji, image or letter.');
  const value = body.icon_value !== undefined ? str(body.icon_value, 500) : (fallback.icon_value || '');
  if (!value) throw new HttpError(400, 'An app icon is required.');
  if (type === 'image') {
    const ref = safeAssetRef(value);
    if (!ref) throw new HttpError(400, 'Icon image must be an uploaded file or a valid image URL.');
    return { icon_type: type, icon_value: ref };
  }
  return { icon_type: type, icon_value: value.slice(0, 16) };
}

function validateEmbedMode(value, fallback = 'auto') {
  const mode = str(value, 12) || fallback;
  if (!['auto', 'inline', 'external'].includes(mode)) throw new HttpError(400, 'Embed mode must be auto, inline or external.');
  return mode;
}

/* ------------------------------------------------------------------ routes */

export const routes = {
  'GET /overview': {
    auth: 'admin',
    handler: async ({ db, session }) => {
      const tenant = tenantId(session);
      const count = async (sql, ...args) => (await db.first(sql, args))?.n ?? 0;

      const stats = {
        users: await count('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', tenant),
        activeUsers: await count("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND status = 'active'", tenant),
        apps: await count('SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ?', tenant),
        enabledApps: await count('SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ? AND is_enabled = 1 AND is_visible = 1', tenant),
        hiddenApps: await count('SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ? AND (is_enabled = 0 OR is_visible = 0)', tenant),
        wallpapers: await count('SELECT COUNT(*) AS n FROM wallpapers WHERE tenant_id = ?', tenant),
        enabledWallpapers: await count('SELECT COUNT(*) AS n FROM wallpapers WHERE tenant_id = ? AND is_enabled = 1', tenant),
        launches: await count('SELECT COALESCE(SUM(open_count),0) AS n FROM app_usage u JOIN users us ON us.id = u.user_id WHERE us.tenant_id = ?', tenant),
        sessionsNow: await count('SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.tenant_id = ? AND s.expires_at > ?', tenant, nowIso()),
        newUsers7d: await count('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND created_at > ?', tenant, new Date(Date.now() - 7 * 864e5).toISOString()),
      };
      stats.disabledUsers = stats.users - stats.activeUsers;

      const topApps = await db.all(
        'SELECT id, name, icon_type, icon_value, icon_bg, open_count FROM apps WHERE tenant_id = ? ORDER BY open_count DESC, name LIMIT 6',
        [tenant]
      );
      const usageByApp = await db.all(
        `SELECT a.name, COALESCE(SUM(u.open_count),0) AS launches
           FROM apps a LEFT JOIN app_usage u ON u.app_id = a.id
          WHERE a.tenant_id = ? GROUP BY a.id ORDER BY launches DESC, a.name LIMIT 6`,
        [tenant]
      );
      const signups = await db.all(
        "SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM users WHERE tenant_id = ? GROUP BY day ORDER BY day DESC LIMIT 14",
        [tenant]
      );
      const activity = await db.all('SELECT * FROM activity_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 12', [tenant]);

      return {
        body: {
          workspace: { ...presentTenant(session.tenant, session.user), members: stats.users },
          stats,
          topApps: topApps.map((a) => ({ id: a.id, name: a.name, icon: { type: a.icon_type, value: a.icon_value, bg: a.icon_bg }, open_count: a.open_count })),
          usageByApp,
          signups: signups.reverse(),
          activity,
        },
      };
    },
  },

  'GET /activity': {
    auth: 'admin',
    handler: async ({ db, session, url }) => {
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 60);
      return { body: { activity: await db.all('SELECT * FROM activity_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId(session), limit]) } };
    },
  },

  /* ---------------------------------------------------------------- apps */

  'GET /apps': {
    auth: 'admin',
    handler: async ({ db, session }) => ({
      body: {
        apps: (await db.all(
          'SELECT * FROM apps WHERE tenant_id = ? ORDER BY is_system DESC, is_pinned DESC, sort_order ASC, name COLLATE NOCASE ASC',
          [tenantId(session)]
        )).map((a) => presentApp(a)),
      },
    }),
  },

  /** Creating an app requires exactly: name + link + icon. */
  'POST /apps': {
    auth: 'admin',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const name = str(body.name, 60);
      if (name.length < 2) throw new HttpError(400, 'App name must be at least 2 characters.');
      const url = safeUrl(body.url);
      if (!url) throw new HttpError(400, 'App link must be a valid http(s) URL (for example https://example.com).');
      const icon = validateIcon(body);
      const now = nowIso();

      const info = await db.run(
        `INSERT INTO apps (tenant_id, name, url, icon_type, icon_value, icon_bg, category, description, embed_mode,
                           sort_order, is_enabled, is_visible, is_system, is_pinned, open_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
        [
          tenantId(session), name, url, icon.icon_type, icon.icon_value,
          ACCENT_RE.test(str(body.icon_bg, 9)) ? str(body.icon_bg, 9).toLowerCase() : null,
          str(body.category, 40) || 'General', str(body.description, 300), validateEmbedMode(body.embed_mode),
          clampInt(body.sort_order, 0, 9999, 100),
          body.is_enabled === false ? 0 : 1,
          body.is_visible === false ? 0 : 1,
          body.is_pinned ? 1 : 0, now, now,
        ]
      );
      const created = await db.first('SELECT * FROM apps WHERE id = ?', [info.lastRowId]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'app.created', detail: `Added application "${name}"` });
      return { status: 201, body: { app: presentApp(created) } };
    },
  },

  'PATCH /apps/:id': {
    auth: 'admin',
    handler: async ({ request, db, session, params }) => {
      const app = await findApp(db, tenantId(session), params.id);
      if (!app) throw new HttpError(404, 'Application not found in this workspace.');
      const body = await readJson(request);
      const patch = {};

      if (body.name !== undefined) {
        const name = str(body.name, 60);
        if (name.length < 2) throw new HttpError(400, 'App name must be at least 2 characters.');
        patch.name = name;
      }
      if (body.url !== undefined) {
        if (app.is_system) throw new HttpError(400, 'The link of a system application cannot be changed.');
        const url = safeUrl(body.url);
        if (!url) throw new HttpError(400, 'App link must be a valid http(s) URL.');
        patch.url = url;
      }
      if (body.icon_type !== undefined || body.icon_value !== undefined) {
        Object.assign(patch, validateIcon(body, app));
      }
      if (body.icon_bg !== undefined) patch.icon_bg = ACCENT_RE.test(str(body.icon_bg, 9)) ? str(body.icon_bg, 9).toLowerCase() : null;
      if (body.category !== undefined) patch.category = str(body.category, 40) || 'General';
      if (body.description !== undefined) patch.description = str(body.description, 300);
      if (body.embed_mode !== undefined) {
        if (app.is_system) throw new HttpError(400, 'Embed mode of a system application cannot be changed.');
        patch.embed_mode = validateEmbedMode(body.embed_mode, app.embed_mode);
      }
      if (body.sort_order !== undefined) patch.sort_order = clampInt(body.sort_order, 0, 9999, app.sort_order);
      if (body.is_enabled !== undefined) {
        if (app.is_system && !body.is_enabled) throw new HttpError(400, 'System applications cannot be disabled.');
        patch.is_enabled = body.is_enabled ? 1 : 0;
      }
      if (body.is_visible !== undefined) {
        if (app.is_system && !body.is_visible) throw new HttpError(400, 'The Settings app is always visible to members.');
        patch.is_visible = body.is_visible ? 1 : 0;
      }
      if (body.is_pinned !== undefined) patch.is_pinned = body.is_pinned ? 1 : 0;
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');

      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE apps SET ${sets}, updated_at = ? WHERE id = ? AND tenant_id = ?`, [...Object.values(patch), nowIso(), app.id, tenantId(session)]);
      const updated = await db.first('SELECT * FROM apps WHERE id = ?', [app.id]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'app.updated', detail: `Updated application "${updated.name}"` });
      return { body: { app: presentApp(updated) } };
    },
  },

  'DELETE /apps/:id': {
    auth: 'admin',
    handler: async ({ db, session, params }) => {
      const app = await findApp(db, tenantId(session), params.id);
      if (!app) throw new HttpError(404, 'Application not found in this workspace.');
      if (app.is_system) throw new HttpError(400, 'System applications cannot be deleted.');
      await db.run('DELETE FROM app_usage WHERE app_id = ?', [app.id]);
      await db.run('DELETE FROM apps WHERE id = ? AND tenant_id = ?', [app.id, tenantId(session)]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'app.deleted', detail: `Deleted application "${app.name}"` });
      return { body: { ok: true } };
    },
  },

  /** Icon upload → R2. Returns a /media URL that can be saved as the app icon. */
  'POST /uploads/icon': {
    auth: 'admin',
    handler: async ({ request, env, session, settings }) => {
      const upload = await storeUpload(env, request, {
        tenantId: tenantId(session),
        kind: 'icons',
        maxBytes: Number(settings.upload_max_bytes),
      });
      return { status: 201, body: { url: upload.url, key: upload.key, size: upload.size, content_type: upload.contentType } };
    },
  },

  /* ------------------------------------------------------------ wallpapers */

  'GET /wallpapers': {
    auth: 'admin',
    handler: async ({ db, session }) => ({
      body: { wallpapers: (await db.all('SELECT * FROM wallpapers WHERE tenant_id = ? ORDER BY sort_order ASC, id ASC', [tenantId(session)])).map(presentWallpaper) },
    }),
  },

  'POST /wallpapers': {
    auth: 'admin',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const name = str(body.name, 80);
      if (name.length < 2) throw new HttpError(400, 'Wallpaper name must be at least 2 characters.');
      const kind = str(body.kind, 10) || 'image';
      if (!['image', 'css'].includes(kind)) throw new HttpError(400, 'Wallpaper kind must be image or css.');

      const rawValue = str(body.value, 1000);
      let value;
      if (kind === 'css') {
        if (!rawValue || rawValue.includes('<')) throw new HttpError(400, 'Enter a CSS background value.');
        value = rawValue;
      } else {
        value = safeAssetRef(rawValue);
        if (!value) throw new HttpError(400, 'Provide an image URL or upload a file first.');
      }

      const isDefault = !!body.is_default;
      if (isDefault) await db.run('UPDATE wallpapers SET is_default = 0 WHERE tenant_id = ?', [tenantId(session)]);
      const now = nowIso();
      const info = await db.run(
        `INSERT INTO wallpapers (tenant_id, name, description, kind, value, thumb, storage_key, is_enabled, is_default, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId(session), name, str(body.description, 300), kind, value,
          kind === 'image' ? (safeAssetRef(str(body.thumb, 1000)) || value) : null,
          str(body.storage_key, 300) || null,
          body.is_enabled === false ? 0 : 1,
          isDefault ? 1 : 0,
          clampInt(body.sort_order, 0, 9999, 100), now, now,
        ]
      );
      const created = await db.first('SELECT * FROM wallpapers WHERE id = ?', [info.lastRowId]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'wallpaper.created', detail: `Added wallpaper "${created.name}"` });
      return { status: 201, body: { wallpaper: presentWallpaper(created) } };
    },
  },

  'PATCH /wallpapers/:id': {
    auth: 'admin',
    handler: async ({ request, db, session, params }) => {
      const wp = await findWallpaper(db, tenantId(session), params.id);
      if (!wp) throw new HttpError(404, 'Wallpaper not found in this workspace.');
      const body = await readJson(request);
      const patch = {};

      if (body.name !== undefined) {
        const name = str(body.name, 80);
        if (name.length < 2) throw new HttpError(400, 'Wallpaper name must be at least 2 characters.');
        patch.name = name;
      }
      if (body.description !== undefined) patch.description = str(body.description, 300);
      if (body.value !== undefined) {
        const raw = str(body.value, 1000);
        const value = wp.kind === 'css' ? (raw.includes('<') ? null : raw) : safeAssetRef(raw);
        if (!value) throw new HttpError(400, 'Provide a valid image URL or CSS background value.');
        patch.value = value;
        if (wp.kind === 'image') patch.thumb = safeAssetRef(str(body.thumb, 1000)) || value;
      }
      if (body.sort_order !== undefined) patch.sort_order = clampInt(body.sort_order, 0, 9999, wp.sort_order);
      if (body.is_enabled !== undefined) patch.is_enabled = body.is_enabled ? 1 : 0;
      if (body.is_default !== undefined) {
        if (body.is_default) await db.run('UPDATE wallpapers SET is_default = 0 WHERE tenant_id = ?', [tenantId(session)]);
        patch.is_default = body.is_default ? 1 : 0;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');

      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE wallpapers SET ${sets}, updated_at = ? WHERE id = ? AND tenant_id = ?`, [...Object.values(patch), nowIso(), wp.id, tenantId(session)]);
      const updated = await db.first('SELECT * FROM wallpapers WHERE id = ?', [wp.id]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'wallpaper.updated', detail: `Updated wallpaper "${updated.name}"` });
      return { body: { wallpaper: presentWallpaper(updated) } };
    },
  },

  'DELETE /wallpapers/:id': {
    auth: 'admin',
    handler: async ({ db, session, params }) => {
      const wp = await findWallpaper(db, tenantId(session), params.id);
      if (!wp) throw new HttpError(404, 'Wallpaper not found in this workspace.');
      const others = await db.first('SELECT COUNT(*) AS n FROM wallpapers WHERE tenant_id = ? AND id <> ?', [tenantId(session), wp.id]);
      if ((others?.n ?? 0) === 0) throw new HttpError(400, 'At least one wallpaper must remain available. Add a replacement first.');
      await db.run('UPDATE user_settings SET wallpaper_id = NULL WHERE wallpaper_id = ?', [wp.id]);
      await db.run('DELETE FROM wallpapers WHERE id = ? AND tenant_id = ?', [wp.id, tenantId(session)]);
      if (wp.is_default) {
        const next = await db.first('SELECT id FROM wallpapers WHERE tenant_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1', [tenantId(session)]);
        if (next) await db.run('UPDATE wallpapers SET is_default = 1 WHERE id = ?', [next.id]);
      }
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'wallpaper.deleted', detail: `Deleted wallpaper "${wp.name}"` });
      return { body: { ok: true, deleted_storage_key: wp.storage_key || null } };
    },
  },

  /**
   * Upload a wallpaper image straight into R2 and create its record in one call.
   * The multipart form carries `name`, `description`, `is_default`, `sort_order`.
   */
  'POST /wallpapers/upload': {
    auth: 'admin',
    handler: async ({ request, db, env, session, settings }) => {
      const upload = await storeUpload(env, request, {
        tenantId: tenantId(session),
        kind: 'wallpapers',
        maxBytes: Number(settings.upload_max_bytes),
      });
      const fields = upload.fields;
      const name = str(fields.get('name'), 80) || 'Untitled wallpaper';
      const description = str(fields.get('description'), 300);
      const isDefault = ['1', 'true', 'on'].includes(String(fields.get('is_default') || '').toLowerCase());
      const sortOrder = clampInt(fields.get('sort_order'), 0, 9999, 100);

      if (isDefault) await db.run('UPDATE wallpapers SET is_default = 0 WHERE tenant_id = ?', [tenantId(session)]);
      const now = nowIso();
      const info = await db.run(
        `INSERT INTO wallpapers (tenant_id, name, description, kind, value, thumb, storage_key, is_enabled, is_default, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'image', ?, ?, ?, 1, ?, ?, ?, ?)`,
        [tenantId(session), name, description, upload.url, upload.url, upload.key, isDefault ? 1 : 0, sortOrder, now, now]
      );
      const created = await db.first('SELECT * FROM wallpapers WHERE id = ?', [info.lastRowId]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'wallpaper.created', detail: `Uploaded wallpaper "${created.name}"` });
      return { status: 201, body: { wallpaper: presentWallpaper(created) } };
    },
  },

  /* --------------------------------------------------------------- members */

  'GET /users': {
    auth: 'admin',
    handler: async ({ db, session, url }) => {
      const q = str(url.searchParams.get('q'), 80);
      const status = str(url.searchParams.get('status'), 20);
      const role = str(url.searchParams.get('role'), 20);
      const clauses = ['u.tenant_id = ?'];
      const params = [tenantId(session)];
      if (q) {
        clauses.push("(LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(COALESCE(u.title,'')) LIKE ?)");
        const like = `%${q.toLowerCase()}%`;
        params.push(like, like, like);
      }
      if (['active', 'disabled'].includes(status)) { clauses.push('u.status = ?'); params.push(status); }
      if (['user', 'admin', 'owner'].includes(role)) { clauses.push('u.role = ?'); params.push(role); }

      const users = await db.all(
        `SELECT u.*,
                (SELECT COALESCE(SUM(open_count),0) FROM app_usage a WHERE a.user_id = u.id) AS launches,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
           FROM users u
          WHERE ${clauses.join(' AND ')}
          ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.created_at DESC`,
        [nowIso(), ...params]
      );
      const summary = await db.first(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
                SUM(CASE WHEN role IN ('admin','owner') THEN 1 ELSE 0 END) AS admins
           FROM users WHERE tenant_id = ?`,
        [tenantId(session)]
      );
      return {
        body: {
          users: users.map((u) => ({ ...presentUser(u), launches: u.launches, active_sessions: u.active_sessions, is_self: u.id === session.user.id })),
          summary: { total: summary?.total ?? 0, active: summary?.active ?? 0, disabled: summary?.disabled ?? 0, admins: summary?.admins ?? 0 },
        },
      };
    },
  },

  'POST /users': {
    auth: 'admin',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const name = str(body.name, 80);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? '');
      const role = ['user', 'admin'].includes(body.role) ? body.role : 'user';
      if (name.length < 2) throw new HttpError(400, "Enter the member's full name.");
      if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
      const problem = passwordProblem(password);
      if (problem) throw new HttpError(400, problem);

      const tenant = session.tenant;
      const members = await db.first('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [tenant.id]);
      if ((members?.n ?? 0) >= tenant.max_users) throw new HttpError(400, 'This workspace has reached its member limit.');
      const duplicate = await db.first('SELECT id FROM users WHERE tenant_id = ? AND LOWER(email) = ?', [tenant.id, email]);
      if (duplicate) throw new HttpError(409, 'That email is already registered in this workspace.');

      const now = nowIso();
      const info = await db.run(
        `INSERT INTO users (tenant_id, name, email, password_hash, role, status, avatar_type, title, verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 'letter', ?, 0, ?, ?)`,
        [tenant.id, name, email, await hashPassword(password), role, str(body.title, 80), now, now]
      );
      await ensureUserSettings(db, info.lastRowId);
      const created = await db.first('SELECT * FROM users WHERE id = ?', [info.lastRowId]);
      await logActivity(db, { tenantId: tenant.id, userId: session.user.id, actor: session.user.email, action: 'user.created', detail: `Created account ${email}` });
      return { status: 201, body: { user: presentUser(created) } };
    },
  },

  'GET /users/:id': {
    auth: 'admin',
    handler: async ({ db, session, params }) => {
      const user = await db.first('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(params.id), tenantId(session)]);
      if (!user) throw new HttpError(404, 'User not found in this workspace.');
      const settings = await ensureUserSettings(db, user.id);
      const wallpaper = settings.wallpaper_id
        ? await db.first('SELECT id, name, value, kind FROM wallpapers WHERE id = ?', [settings.wallpaper_id])
        : null;
      const usage = await db.all(
        `SELECT a.name, a.icon_type, a.icon_value, u.open_count, u.last_opened_at
           FROM app_usage u JOIN apps a ON a.id = u.app_id
          WHERE u.user_id = ? ORDER BY u.open_count DESC LIMIT 10`,
        [user.id]
      );
      const sessions = await db.all(
        'SELECT user_agent, ip, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 10',
        [user.id, nowIso()]
      );
      const activity = await db.all('SELECT action, detail, created_at FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 15', [user.id]);
      return {
        body: {
          user: { ...presentUser(user), launches: usage.reduce((sum, u) => sum + u.open_count, 0) },
          settings: presentSettings(settings),
          wallpaper,
          usage,
          sessions,
          activity,
        },
      };
    },
  },

  'PATCH /users/:id': {
    auth: 'admin',
    handler: async ({ request, db, session, params }) => {
      const user = await db.first('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(params.id), tenantId(session)]);
      if (!user) throw new HttpError(404, 'User not found in this workspace.');
      const body = await readJson(request);
      const patch = {};
      const self = user.id === session.user.id;

      if (body.name !== undefined) {
        const name = str(body.name, 80);
        if (name.length < 2) throw new HttpError(400, 'Name must be at least 2 characters.');
        patch.name = name;
      }
      if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
        const clash = await db.first('SELECT id FROM users WHERE tenant_id = ? AND LOWER(email) = ? AND id <> ?', [tenantId(session), email, user.id]);
        if (clash) throw new HttpError(409, 'Another member already uses that email.');
        patch.email = email;
      }
      if (body.title !== undefined) patch.title = str(body.title, 80);
      if (body.phone !== undefined) patch.phone = str(body.phone, 40);

      if (body.role !== undefined) {
        const role = str(body.role, 10);
        if (!['user', 'admin', 'owner'].includes(role)) throw new HttpError(400, 'Role must be user, admin or owner.');
        if (role === 'owner' && session.user.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can transfer ownership.');
        if (user.role === 'owner' && role !== 'owner' && self) throw new HttpError(400, 'You cannot remove your own owner role.');
        if (role !== user.role) {
          if (role === 'user') await assertNotLastAdmin(db, tenantId(session), user, 'demote');
          patch.role = role;
        }
      }
      if (body.status !== undefined) {
        const status = body.status ? 'active' : 'disabled';
        if (self && status === 'disabled') throw new HttpError(400, 'You cannot suspend your own account.');
        if (status !== user.status) {
          if (status === 'disabled') await assertNotLastAdmin(db, tenantId(session), user, 'suspend');
          patch.status = status;
        }
      }
      if (body.avatar && typeof body.avatar === 'object') {
        const type = str(body.avatar.type, 10) || 'letter';
        if (!['letter', 'emoji', 'image'].includes(type)) throw new HttpError(400, 'Unsupported avatar type.');
        patch.avatar_type = type;
        patch.avatar_value = str(body.avatar.value, 300) || null;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');

      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ? AND tenant_id = ?`, [...Object.values(patch), nowIso(), user.id, tenantId(session)]);
      if (patch.status === 'disabled') await destroyUserSessions(db, user.id);

      const updated = await db.first('SELECT * FROM users WHERE id = ?', [user.id]);
      await logActivity(db, {
        tenantId: tenantId(session),
        userId: session.user.id,
        actor: session.user.email,
        action: patch.status === 'disabled' ? 'user.disabled' : patch.status === 'active' ? 'user.activated' : 'user.updated',
        detail: `${patch.status === 'disabled' ? 'Suspended' : patch.status === 'active' ? 'Reactivated' : 'Updated'} account ${updated.email}`,
      });
      return { body: { user: presentUser(updated) } };
    },
  },

  'POST /users/:id/reset-password': {
    auth: 'admin',
    handler: async ({ request, db, session, params }) => {
      const user = await db.first('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(params.id), tenantId(session)]);
      if (!user) throw new HttpError(404, 'User not found in this workspace.');
      const body = await readJson(request);
      const password = String(body.new_password ?? '');
      const problem = passwordProblem(password);
      if (problem) throw new HttpError(400, problem);
      await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [await hashPassword(password), nowIso(), user.id]);
      await destroyUserSessions(db, user.id);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'user.password_reset', detail: `Reset password for ${user.email}` });
      return { body: { ok: true, message: `Password reset for ${user.email}. They must sign in again.` } };
    },
  },

  'DELETE /users/:id': {
    auth: 'admin',
    handler: async ({ db, session, params }) => {
      const user = await db.first('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [Number(params.id), tenantId(session)]);
      if (!user) throw new HttpError(404, 'User not found in this workspace.');
      if (user.id === session.user.id) throw new HttpError(400, 'You cannot delete your own account from the admin console.');
      await assertNotLastAdmin(db, tenantId(session), user, 'delete');
      await db.run('DELETE FROM app_usage WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM user_settings WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
      await db.run('DELETE FROM users WHERE id = ? AND tenant_id = ?', [user.id, tenantId(session)]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'user.deleted', detail: `Deleted account ${user.email}` });
      return { body: { ok: true } };
    },
  },

  /* ----------------------------------------------------- workspace + config */

  'PATCH /workspace': {
    auth: 'admin',
    handler: async ({ request, db, session }) => {
      const body = await readJson(request);
      const patch = {};
      if (body.name !== undefined) {
        const name = str(body.name, 60);
        if (name.length < 2) throw new HttpError(400, 'Workspace name must be at least 2 characters.');
        patch.name = name;
      }
      if (body.allow_join !== undefined) patch.allow_join = body.allow_join ? 1 : 0;
      if (body.max_users !== undefined) patch.max_users = clampInt(body.max_users, 1, 100000, session.tenant.max_users);
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');

      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE tenants SET ${sets} WHERE id = ?`, [...Object.values(patch), tenantId(session)]);
      const updated = await db.first('SELECT * FROM tenants WHERE id = ?', [tenantId(session)]);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'workspace.updated', detail: 'Updated workspace settings' });
      return { body: { workspace: presentTenant(updated, session.user) } };
    },
  },

  /** Deployment-level settings (stored in D1, editable from the console). */
  'GET /settings': {
    auth: 'admin',
    handler: async ({ db, session, settings, media }) => {
      const tenants = await db.first('SELECT COUNT(*) AS n FROM tenants');
      const users = await db.first('SELECT COUNT(*) AS n FROM users');
      const objects = await db.first(
        `SELECT
           (SELECT COUNT(*) FROM wallpapers WHERE storage_key IS NOT NULL) +
           (SELECT COUNT(*) FROM users WHERE avatar_type = 'image') AS n`
      );
      return {
        body: {
          settings: {
            service_name: settings.service_name,
            registration_mode: settings.registration_mode,
            max_users_per_tenant: Number(settings.max_users_per_tenant),
            max_tenants: Number(settings.max_tenants),
            upload_max_bytes: Number(settings.upload_max_bytes),
            embed_probe_enabled: settings.embed_probe_enabled === 'true',
            support_email: settings.support_email,
            initialized_at: settings.initialized_at || null,
          },
          deployment: {
            tenants: tenants?.n ?? 0,
            users: users?.n ?? 0,
            stored_objects: objects?.n ?? 0,
            database: { mode: settings.__dbMode || null },
          },
          storage: media,
          role: session.user.role,
        },
      };
    },
  },

  'PATCH /settings': {
    auth: 'admin',
    handler: async ({ request, db, session, settings }) => {
      const body = await readJson(request);
      const patch = {};
      if (body.service_name !== undefined) {
        const name = str(body.service_name, 60);
        if (name.length < 2) throw new HttpError(400, 'Service name must be at least 2 characters.');
        patch.service_name = name;
      }
      if (body.registration_mode !== undefined) {
        patch.registration_mode = body.registration_mode === 'open' ? 'open' : 'closed';
      }
      if (body.max_users_per_tenant !== undefined) patch.max_users_per_tenant = clampInt(body.max_users_per_tenant, 1, 100000, Number(settings.max_users_per_tenant));
      if (body.max_tenants !== undefined) patch.max_tenants = clampInt(body.max_tenants, 1, 100000, Number(settings.max_tenants));
      if (body.upload_max_bytes !== undefined) patch.upload_max_bytes = clampInt(body.upload_max_bytes, 65536, 100 * 1024 * 1024, Number(settings.upload_max_bytes));
      if (body.embed_probe_enabled !== undefined) patch.embed_probe_enabled = body.embed_probe_enabled ? 'true' : 'false';
      if (body.support_email !== undefined) {
        const email = str(body.support_email, 190);
        if (email && !isValidEmail(email)) throw new HttpError(400, 'Support email must be a valid email address.');
        patch.support_email = email;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update.');
      await saveSettings(db, patch);
      await logActivity(db, { tenantId: tenantId(session), userId: session.user.id, actor: session.user.email, action: 'settings.updated', detail: `Updated deployment settings (${Object.keys(patch).join(', ')})` });
      return { body: { ok: true, updated: Object.keys(patch) } };
    },
  },
};
