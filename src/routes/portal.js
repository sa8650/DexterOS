/**
 * DexterOS — user console routes (/api/portal).
 * Everything the desktop shows is read from the database and scoped to the
 * signed-in user's workspace; nothing is hard-coded in the front-end.
 */
import { HttpError, nowIso, str } from '../lib/util.js';
import { presentApp, presentSettings, presentTenant, presentUser, presentWallpaper } from '../lib/presenters.js';
import { ensureUserSettings, getWallpaperFor } from '../lib/wallpaper.js';
import { logActivity } from '../lib/activity.js';
import { probeEmbed } from '../lib/embed.js';

const visibleApps = (db, tenantId) =>
  db.all(
    `SELECT * FROM apps
      WHERE tenant_id = ? AND is_enabled = 1 AND is_visible = 1
      ORDER BY is_pinned DESC, sort_order ASC, name COLLATE NOCASE ASC`,
    [tenantId]
  );

const activeWallpapers = (db, tenantId) =>
  db.all('SELECT * FROM wallpapers WHERE tenant_id = ? AND is_enabled = 1 ORDER BY sort_order ASC, id ASC', [tenantId]);

async function usageMap(db, userId) {
  const rows = await db.all('SELECT app_id, open_count, last_opened_at FROM app_usage WHERE user_id = ?', [userId]);
  return new Map(rows.map((r) => [r.app_id, r]));
}

export const routes = {
  /** One request that boots the whole desktop. */
  'GET /bootstrap': {
    auth: 'user',
    handler: async ({ db, session, settings }) => {
      const { user, tenant } = session;
      const usage = await usageMap(db, user.id);
      const apps = (await visibleApps(db, tenant.id)).map((a) => presentApp(a, usage.get(a.id)));
      const wallpapers = (await activeWallpapers(db, tenant.id)).map(presentWallpaper);
      const recent = apps
        .filter((a) => a.usage.last_opened_at)
        .sort((a, b) => String(b.usage.last_opened_at).localeCompare(String(a.usage.last_opened_at)))
        .slice(0, 5);
      const recommended = apps.slice().sort((a, b) => b.open_count - a.open_count).slice(0, 4);

      return {
        body: {
          user: presentUser(user),
          tenant: presentTenant(tenant, user),
          settings: presentSettings(await ensureUserSettings(db, user.id)),
          wallpaper: await getWallpaperFor(db, user.id, tenant.id),
          apps,
          wallpapers,
          recent,
          recommended,
          service: {
            name: settings.service_name,
            version: '3.0',
            build: 'Pages',
            database: 'D1',
            storage: 'R2',
          },
        },
      };
    },
  },

  'GET /apps': {
    auth: 'user',
    handler: async ({ db, session }) => {
      const usage = await usageMap(db, session.user.id);
      return { body: { apps: (await visibleApps(db, session.user.tenant_id)).map((a) => presentApp(a, usage.get(a.id))) } };
    },
  },

  'POST /apps/:id/launch': {
    auth: 'user',
    handler: async ({ db, session, params }) => {
      const app = await db.first(
        'SELECT * FROM apps WHERE id = ? AND tenant_id = ? AND is_enabled = 1 AND is_visible = 1',
        [Number(params.id), session.user.tenant_id]
      );
      if (!app) throw new HttpError(404, 'That application is not available.');
      const now = nowIso();
      await db.run('UPDATE apps SET open_count = open_count + 1 WHERE id = ?', [app.id]);
      await db.run(
        `INSERT INTO app_usage (user_id, app_id, open_count, last_opened_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(user_id, app_id) DO UPDATE SET open_count = open_count + 1, last_opened_at = excluded.last_opened_at`,
        [session.user.id, app.id, now]
      );
      await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: session.user.email, action: 'app.launched', detail: `Opened "${app.name}"` });
      return { body: { ok: true, app: presentApp(app) } };
    },
  },

  'GET /wallpapers': {
    auth: 'user',
    handler: async ({ db, session }) => ({
      body: {
        wallpapers: (await activeWallpapers(db, session.user.tenant_id)).map(presentWallpaper),
        active: await getWallpaperFor(db, session.user.id, session.user.tenant_id),
      },
    }),
  },

  /**
   * Frame-embedding check. Only URLs already configured as apps in the caller's
   * workspace can be probed, so this cannot be used as an open proxy.
   */
  'GET /embed-check': {
    auth: 'user',
    handler: async ({ db, session, url, settings }) => {
      const target = str(url.searchParams.get('url'), 2000);
      if (!target) throw new HttpError(400, 'A url parameter is required.');
      const app = await db.first('SELECT id, embed_mode FROM apps WHERE tenant_id = ? AND url = ?', [session.user.tenant_id, target]);
      if (!app) throw new HttpError(403, 'Only applications configured in this workspace can be checked.', 'NOT_CONFIGURED_APP');

      if (app.embed_mode === 'inline') return { body: { embeddable: 1, reason: 'Administrator marked this app as embeddable.', enforced: true } };
      if (app.embed_mode === 'external') return { body: { embeddable: 0, reason: 'Administrator marked this app as external (opens in a secure DexterOS window).', enforced: true } };
      if (settings.embed_probe_enabled !== 'true') {
        return { body: { embeddable: null, reason: 'Embedding checks are disabled on this deployment.', enforced: false } };
      }

      const force = url.searchParams.get('recheck') === '1';
      const result = await probeEmbed(db, target, { force });
      return { body: { ...result, enforced: false } };
    },
  },

  'GET /stats': {
    auth: 'user',
    handler: async ({ db, session }) => {
      const launches = await db.first('SELECT COALESCE(SUM(open_count),0) AS n FROM app_usage WHERE user_id = ?', [session.user.id]);
      const sessions = await db.first('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?', [session.user.id, nowIso()]);
      const apps = await db.first('SELECT COUNT(*) AS n FROM apps WHERE tenant_id = ? AND is_enabled = 1 AND is_visible = 1', [session.user.tenant_id]);
      return {
        body: {
          stats: {
            launches: launches?.n ?? 0,
            active_sessions: sessions?.n ?? 0,
            available_apps: apps?.n ?? 0,
            member_since: session.user.created_at,
            last_login_at: session.user.last_login_at,
            settings: presentSettings(await ensureUserSettings(db, session.user.id)),
            user: presentUser(session.user),
          },
        },
      };
    },
  },
};
