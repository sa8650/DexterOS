/**
 * DexterOS — authentication routes.
 *
 * Registration is closed by default on a production deployment: the setup wizard
 * creates the first workspace, and an administrator decides afterwards whether
 * new self-service workspaces are allowed (Settings → registration_mode) or
 * whether teammates may join an existing workspace with its join code.
 */
import { HttpError, conflict, forbidden, isValidEmail, joinCode, normalizeEmail, nowIso, passwordProblem, slugify, str } from '../lib/util.js';
import { clientIp, rateLimit, readJson } from '../lib/http.js';
import { createSession, destroySession, hashPassword, verifyPassword } from '../lib/auth.js';
import { presentSettings, presentTenant, presentUser } from '../lib/presenters.js';
import { scaffoldTenant } from '../lib/schema.js';
import { logActivity } from '../lib/activity.js';
import { DEFAULT_ACCENT, ensureUserSettings, getWallpaperFor } from '../lib/wallpaper.js';

const ipKey = (request, bucket) => `auth:${bucket}:${clientIp(request)}`;

async function uniqueTenantIdentity(db, name) {
  const base = slugify(name);
  let slug = base;
  let attempt = 1;
  // Slugs must be unique; join codes are random so a retry is enough.
  for (;;) {
    const taken = await db.first('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (!taken) break;
    slug = `${base}-${attempt++}`.slice(0, 48);
  }
  let code = joinCode(slug.slice(0, 3).toUpperCase());
  for (let i = 0; i < 5; i += 1) {
    const clash = await db.first('SELECT id FROM tenants WHERE join_code = ?', [code]);
    if (!clash) break;
    code = joinCode(slug.slice(0, 3).toUpperCase());
  }
  return { slug, code };
}

async function tenantCount(db) {
  const row = await db.first('SELECT COUNT(*) AS n FROM tenants');
  return row?.n ?? 0;
}

export const routes = {
  'POST /register': {
    auth: 'none',
    handler: async ({ request, db, settings }) => {
      await rateLimit(db, ipKey(request, 'register'), { limit: 10, windowMs: 60_000 });
      const body = await readJson(request);
      const mode = body.mode === 'join' ? 'join' : 'create';
      const name = str(body.name, 80);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? '');

      if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
      if (!isValidEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
      const pwProblem = passwordProblem(password);
      if (pwProblem) throw new HttpError(400, pwProblem);

      let tenant;
      let role;
      const now = nowIso();

      if (mode === 'create') {
        if (settings.registration_mode !== 'open') {
          throw forbidden(
            'Self-service workspaces are disabled on this deployment. Ask an administrator for a join code, or ask them to enable new workspaces.',
            'REGISTRATION_CLOSED'
          );
        }
        if ((await tenantCount(db)) >= Number(settings.max_tenants)) {
          throw forbidden('This deployment has reached its workspace limit.', 'TENANT_LIMIT');
        }
        const workspaceName = str(body.workspace_name, 60);
        if (workspaceName.length < 2) throw new HttpError(400, 'Please choose a workspace name (2+ characters).');
        const { slug, code } = await uniqueTenantIdentity(db, workspaceName);
        const info = await db.run(
          `INSERT INTO tenants (name, slug, join_code, plan, status, allow_join, max_users, created_at)
           VALUES (?, ?, ?, 'pro', 'active', 1, ?, ?)`,
          [workspaceName, slug, code, Number(settings.max_users_per_tenant), now]
        );
        tenant = await db.first('SELECT * FROM tenants WHERE id = ?', [info.lastRowId]);
        role = 'owner';
      } else {
        const code = str(body.workspace_code, 60);
        if (!code) throw new HttpError(400, 'Enter your workspace join code.');
        tenant = await db.first('SELECT * FROM tenants WHERE UPPER(join_code) = UPPER(?) OR LOWER(slug) = LOWER(?)', [code, code]);
        if (!tenant) throw new HttpError(404, 'No workspace matches that join code.');
        if (!tenant.allow_join) throw forbidden('This workspace is not accepting new members right now.', 'JOIN_CLOSED');
        if (tenant.status !== 'active') throw forbidden('This workspace is suspended. Please contact an administrator.');
        const members = await db.first('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [tenant.id]);
        if ((members?.n ?? 0) >= tenant.max_users) throw forbidden('This workspace has reached its member limit.', 'USER_LIMIT');
        role = 'user';
      }

      const duplicate = await db.first('SELECT id FROM users WHERE tenant_id = ? AND LOWER(email) = ?', [tenant.id, email]);
      if (duplicate) {
        throw conflict(
          mode === 'create' ? 'That email is already registered in this workspace.' : 'That email is already registered in this workspace — try signing in instead.',
          'EMAIL_TAKEN'
        );
      }

      const info = await db.run(
        `INSERT INTO users (tenant_id, name, email, password_hash, role, status, avatar_type, title, verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 'letter', ?, 0, ?, ?)`,
        [tenant.id, name, email, await hashPassword(password), role, mode === 'create' ? 'Workspace owner' : 'Team member', now, now]
      );
      const userId = info.lastRowId;
      await db.run(
        `INSERT INTO user_settings (user_id, wallpaper_id, accent, theme, taskbar_align, icon_size, show_labels, reduced_transparency, updated_at)
         VALUES (?, (SELECT id FROM wallpapers WHERE tenant_id = ? AND is_enabled = 1 ORDER BY is_default DESC, sort_order ASC LIMIT 1),
                 ?, 'dark', 'center', 'medium', 1, 0, ?)`,
        [userId, tenant.id, DEFAULT_ACCENT, now]
      );

      // Every workspace starts with the un-removable Settings app and a starter
      // wallpaper set, so the desktop is never empty and Settings always exists.
      await scaffoldTenant(db, tenant.id);

      const user = await db.first('SELECT * FROM users WHERE id = ?', [userId]);
      const session = await createSession(db, user, request, {
        ip: clientIp(request),
        userAgent: request.headers.get('user-agent'),
      });
      await logActivity(db, {
        tenantId: tenant.id,
        userId,
        actor: email,
        action: mode === 'create' ? 'workspace.created' : 'user.registered',
        detail: mode === 'create' ? `Workspace "${tenant.name}" created` : 'Joined the workspace',
      });
      const wallpaper = await getWallpaperFor(db, userId, tenant.id);
      return {
        status: 201,
        body: {
          token: session.token,
          user: presentUser(user),
          tenant: presentTenant(tenant, user),
          settings: presentSettings(await ensureUserSettings(db, userId)),
          wallpaper,
        },
        cookies: [session.cookie],
      };
    },
  },

  'POST /login': {
    auth: 'none',
    handler: async ({ request, db }) => {
      await rateLimit(db, ipKey(request, 'login'), { limit: 15, windowMs: 60_000 });
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? '');
      const workspace = str(body.workspace, 60);

      if (!isValidEmail(email) || !password) throw new HttpError(400, 'Enter your email and password.');

      let matches = await db.all(
        `SELECT u.*, t.name AS tenant_name, t.slug AS tenant_slug, t.join_code, t.plan, t.status AS tenant_status,
                t.allow_join, t.max_users, t.created_at AS tenant_created_at
           FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE LOWER(u.email) = ?`,
        [email]
      );
      if (matches.length > 1 && workspace) {
        const filtered = matches.filter(
          (m) => m.join_code?.toUpperCase() === workspace.toUpperCase() || m.tenant_slug?.toLowerCase() === workspace.toLowerCase()
        );
        if (filtered.length) matches = filtered;
      }
      if (matches.length > 1) {
        throw new HttpError(409, 'This email belongs to more than one workspace. Enter your workspace code to continue.', 'WORKSPACE_REQUIRED');
      }

      const user = matches[0];
      const invalid = new HttpError(401, 'Incorrect email or password.');
      if (!user) {
        // Constant-ish work for unknown accounts, so timing does not reveal existence.
        await verifyPassword(password, 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
        throw invalid;
      }
      if (!(await verifyPassword(password, user.password_hash))) throw invalid;
      if (user.status !== 'active') throw forbidden('This account has been suspended by an administrator.', 'ACCOUNT_DISABLED');
      if (user.tenant_status !== 'active') throw forbidden('This workspace is suspended. Please contact an administrator.', 'WORKSPACE_SUSPENDED');

      const now = nowIso();
      await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, user.id]);
      const session = await createSession(db, user, request, { ip: clientIp(request), userAgent: request.headers.get('user-agent') });
      await logActivity(db, { tenantId: user.tenant_id, userId: user.id, actor: user.email, action: 'user.login', detail: 'Signed in' });

      const tenant = {
        id: user.tenant_id,
        name: user.tenant_name,
        slug: user.tenant_slug,
        join_code: user.join_code,
        plan: user.plan,
        status: user.tenant_status,
        allow_join: user.allow_join,
        max_users: user.max_users,
        created_at: user.tenant_created_at,
      };
      const settingsRow = await db.first('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
      return {
        body: {
          token: session.token,
          user: presentUser(user),
          tenant: presentTenant(tenant, user),
          settings: presentSettings(settingsRow),
          wallpaper: await getWallpaperFor(db, user.id, user.tenant_id),
        },
        cookies: [session.cookie],
      };
    },
  },

  'POST /logout': {
    auth: 'optional',
    handler: async ({ request, db, session }) => {
      await destroySession(db, session?.token);
      if (session) {
        await logActivity(db, { tenantId: session.user.tenant_id, userId: session.user.id, actor: session.user.email, action: 'user.logout', detail: 'Signed out' });
      }
      return { body: { ok: true }, clearCookie: true };
    },
  },

  'GET /session': {
    auth: 'user',
    handler: async ({ db, session }) => {
      const settingsRow = await db.first('SELECT * FROM user_settings WHERE user_id = ?', [session.user.id]);
      return {
        body: {
          user: presentUser(session.user),
          tenant: presentTenant(session.tenant, session.user),
          settings: presentSettings(settingsRow),
          wallpaper: await getWallpaperFor(db, session.user.id, session.user.tenant_id),
        },
      };
    },
  },

  'GET /workspace/:code': {
    auth: 'none',
    handler: async ({ request, db, params }) => {
      await rateLimit(db, ipKey(request, 'workspace'), { limit: 60, windowMs: 60_000 });
      const code = str(params.code, 60);
      const tenant = await db.first('SELECT * FROM tenants WHERE UPPER(join_code) = UPPER(?) OR LOWER(slug) = LOWER(?)', [code, code]);
      if (!tenant) throw new HttpError(404, 'No workspace matches that join code.');
      const members = await db.first('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [tenant.id]);
      return {
        body: {
          name: tenant.name,
          slug: tenant.slug,
          plan: tenant.plan,
          members: members?.n ?? 0,
          joinable: !!tenant.allow_join && tenant.status === 'active' && (members?.n ?? 0) < tenant.max_users,
        },
      };
    },
  },
};
