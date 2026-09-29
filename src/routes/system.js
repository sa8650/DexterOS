/**
 * DexterOS — deployment/system routes (/api/system).
 *
 * These endpoints answer "is this deployment wired up yet?" and drive the
 * first-run setup wizard. They are the only routes that work without a database
 * binding, because they must be able to explain *what* still needs configuring
 * in the Cloudflare dashboard.
 *
 * The only Cloudflare configuration DexterOS understands is a *binding*: the
 * D1 database bound as "DB" and the R2 bucket bound as "MEDIA" in the Pages
 * project settings. There is no API token, no account id and no secret to type
 * anywhere — authentication in this product is the app's own register/login.
 *
 * Everything on this page is written so a first run can never fail silently:
 * setup is executed step by step, the step that broke is recorded, and
 * POST /api/system/diagnostics answers "what exactly is wrong here?".
 */
import { HttpError, isValidEmail, joinCode, normalizeEmail, nowIso, passwordProblem, slugify, str, timingSafeEqual } from '../lib/util.js';
import { clientIp, rateLimit, readJson } from '../lib/http.js';
import { getDb, resolveD1Binding, resolveR2Binding } from '../lib/db.js';
import { deleteObject, getObject, mediaAvailability, putObject } from '../lib/media.js';
import { SCHEMA_VERSION, ensureSchema, scaffoldTenant } from '../lib/schema.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { configureHashing, createSession, hashPassword, hashingProfile, verifyPassword } from '../lib/auth.js';
import { presentSettings, presentTenant, presentUser } from '../lib/presenters.js';
import { getWallpaperFor } from '../lib/wallpaper.js';
import { logActivity } from '../lib/activity.js';

/** Setup-only guard: allowed before initialisation, or with the SETUP_KEY secret. */
function assertSetupAccess(request, env, settings, { requireOpen = false } = {}) {
  const provided = request.headers.get('x-setup-key') || '';
  const expected = str(env.SETUP_KEY, 200);
  if (expected && timingSafeEqual(provided, expected)) return true;
  if (!settings?.initialized) return true;
  if (requireOpen) return false;
  throw new HttpError(
    403,
    'This deployment is already initialised. Set the SETUP_KEY secret in Cloudflare and send it as the x-setup-key header to run diagnostics.',
    'SETUP_LOCKED'
  );
}

/**
 * Runs one setup step. If it throws, the step label is attached to the error so
 * the wizard (and the recorded failure) can say "creating the owner account"
 * instead of "something went wrong".
 */
async function step(label, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error && typeof error === 'object' && !error.setupStep) error.setupStep = label;
    throw error;
  }
}

/** Persists the last setup failure so /setup can show it on the next visit. */
async function recordSetupError(db, error) {
  const detail = `${error?.setupStep ? `${error.setupStep}: ` : ''}${String(error?.message || error).slice(0, 400)}`;
  const now = nowIso();
  for (const [key, value] of [['setup_last_error', detail], ['setup_last_error_at', now]]) {
    try {
      await db.run(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, now]
      );
    } catch { /* never mask the original failure */ }
  }
}

/** Turns any setup exception into something the person running setup can act on. */
function asSetupError(error) {
  if (error instanceof HttpError && error.status < 500) return error;
  const wrapped = new HttpError(
    500,
    `Setup failed${error?.setupStep ? ` while ${error.setupStep}` : ''}: ${error?.message || 'unknown error'}`,
    'SETUP_FAILED'
  );
  return wrapped;
}

/** Reports storage + database wiring without every route having to guess. */
export async function deploymentStatus(env) {
  const status = {
    service: {
      name: 'DexterOS',
      version: '3.0',
      build: 'pages',
    },
    database: {
      configured: false,
      connected: false,
      mode: null,
      binding: null,
      schema_version: null,
      error: null,
    },
    storage: {
      available: false,
      mode: 'unconfigured',
      binding: null,
      message: null,
    },
    initialized: false,
    setup_required: true,
    setup_last_error: null,
    registration_mode: 'closed',
    service_name: 'DexterOS',
    counts: { tenants: 0, users: 0, apps: 0 },
    checks: [],
  };

  const media = mediaAvailability(env);
  status.storage = { available: media.available, mode: media.mode, binding: media.binding, message: media.message || null };

  let db = null;
  try {
    const resolved = getDb(env);
    db = resolved.db;
    status.database.configured = true;
    status.database.mode = resolved.mode;
    status.database.binding = resolved.binding;
  } catch (error) {
    status.database.error = error.message;
    return status;
  }

  try {
    let versionRow = await db.first("SELECT value FROM app_settings WHERE key = 'schema_version'").catch(() => null);
    if (!versionRow) {
      // Brand new database: create the schema now so the setup page can honestly
      // report "connected" instead of asking the operator to do it by hand.
      await ensureSchema(db);
      versionRow = await db.first("SELECT value FROM app_settings WHERE key = 'schema_version'").catch(() => null);
    }
    status.database.schema_version = versionRow?.value || null;
    const probe = await db.first('SELECT COUNT(*) AS n FROM tenants').catch(() => null);
    status.database.connected = probe !== null;
    status.initialized = !!versionRow;
    status.setup_required = !status.initialized;
    if (probe) {
      const settings = await loadSettings(db, env);
      status.registration_mode = settings.registration_mode;
      status.service_name = settings.service_name || 'DexterOS';
      status.service.name = status.service_name;
      const users = await db.first('SELECT COUNT(*) AS n FROM users').catch(() => null);
      const apps = await db.first('SELECT COUNT(*) AS n FROM apps').catch(() => null);
      status.counts = { tenants: probe.n ?? 0, users: users?.n ?? 0, apps: apps?.n ?? 0 };
      status.initialized = !!settings.initialized_at;
      status.setup_required = !settings.initialized_at;
    }
    if (!status.initialized) {
      const lastError = await db.first("SELECT value FROM app_settings WHERE key = 'setup_last_error'").catch(() => null);
      status.setup_last_error = lastError?.value || null;
    }
  } catch (error) {
    status.database.error = error.message;
  }

  status.checks = [
    status.database.configured && status.database.connected
      ? { id: 'database', ok: true, label: 'D1 database', detail: `Connected through the "${status.database.binding}" binding` }
      : { id: 'database', ok: false, label: 'D1 database', detail: status.database.error || 'DexterOS cannot reach the database. Check the D1 binding named "DB" on your Pages project.' },
    status.storage.available
      ? { id: 'storage', ok: true, label: 'R2 storage', detail: `Connected through the "${status.storage.binding}" binding` }
      : { id: 'storage', ok: false, label: 'R2 storage', detail: status.storage.message },
  ];

  return status;
}

/** The first-run body: everything POST /setup does, one tagged step at a time. */
async function createFirstWorkspace(db, env, request) {
  await step('preparing the database', () => ensureSchema(db));
  const settings = await step('reading the deployment settings', () => loadSettings(db, env));

  if (settings.initialized) {
    throw new HttpError(409, 'This deployment has already been set up. Sign in instead.', 'ALREADY_INITIALIZED');
  }
  await step('checking the rate limit', () => rateLimit(db, `setup:${clientIp(request)}`, { limit: 10, windowMs: 300_000 }));

  const body = await step('reading the submitted form', () => readJson(request));
  const workspaceName = str(body.workspace_name, 60);
  const name = str(body.name, 80);
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');

  if (workspaceName.length < 2) throw new HttpError(400, 'Enter a workspace name (2+ characters).');
  if (name.length < 2) throw new HttpError(400, 'Enter your full name.');
  if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);

  const existing = await step('checking for existing accounts', () => db.first('SELECT COUNT(*) AS n FROM users'));
  if ((existing?.n ?? 0) > 0) {
    throw new HttpError(409, 'Accounts already exist on this deployment — setup is closed.', 'ALREADY_INITIALIZED');
  }
  const tenantCount = await step('checking the workspace limit', () => db.first('SELECT COUNT(*) AS n FROM tenants'));
  if ((tenantCount?.n ?? 0) >= Number(settings.max_tenants)) {
    throw new HttpError(400, 'This deployment has reached its workspace limit.', 'TENANT_LIMIT');
  }

  const base = slugify(workspaceName);
  let slug = base;
  let attempt = 1;
  for (;;) {
    const taken = await step('choosing a workspace address', () => db.first('SELECT id FROM tenants WHERE slug = ?', [slug]));
    if (!taken) break;
    slug = `${base}-${attempt++}`.slice(0, 48);
  }
  let code = joinCode(slug.slice(0, 3).toUpperCase());
  for (let i = 0; i < 5; i += 1) {
    const clash = await step('generating the join code', () => db.first('SELECT id FROM tenants WHERE join_code = ?', [code]));
    if (!clash) break;
    code = joinCode(slug.slice(0, 3).toUpperCase());
  }

  const passwordHash = await step('hashing your password', () => hashPassword(password));

  const now = nowIso();
  const tenantInfo = await step('creating the workspace', () => db.run(
    `INSERT INTO tenants (name, slug, join_code, plan, status, allow_join, max_users, created_at)
     VALUES (?, ?, ?, 'pro', 'active', 1, ?, ?)`,
    [workspaceName, slug, code, Number(settings.max_users_per_tenant), now]
  ));
  const tenantId = tenantInfo.lastRowId;

  const userInfo = await step('creating the owner account', () => db.run(
    `INSERT INTO users (tenant_id, name, email, password_hash, role, status, avatar_type, title, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'owner', 'active', 'letter', 'Workspace owner', 0, ?, ?)`,
    [tenantId, name, email, passwordHash, now, now]
  ));
  const userId = userInfo.lastRowId;

  await step('creating the starter content', () => scaffoldTenant(db, tenantId));
  await step('saving your desktop preferences', () => db.run(
    `INSERT INTO user_settings (user_id, wallpaper_id, accent, theme, taskbar_align, icon_size, show_labels, reduced_transparency, updated_at)
     VALUES (?, (SELECT id FROM wallpapers WHERE tenant_id = ? AND is_enabled = 1 ORDER BY is_default DESC, sort_order ASC LIMIT 1),
             '#2563eb', 'dark', 'center', 'medium', 1, 0, ?)`,
    [userId, tenantId, now]
  ));

  await step('locking the deployment', () => saveSettings(db, { initialized_at: now }));
  // The audit entry is nice-to-have: never fail a successful setup over it.
  await logActivity(db, { tenantId, userId, actor: email, action: 'deployment.initialized', detail: `Deployment initialised with workspace "${workspaceName}"` }).catch(() => {});

  const user = await step('loading the new account', () => db.first('SELECT * FROM users WHERE id = ?', [userId]));
  const tenant = await step('loading the new workspace', () => db.first('SELECT * FROM tenants WHERE id = ?', [tenantId]));
  const session = await step('starting your session', () => createSession(db, user, request, { ip: clientIp(request), userAgent: request.headers.get('user-agent') }));

  return {
    status: 201,
    body: {
      token: session.token,
      user: presentUser(user),
      tenant: presentTenant(tenant, user),
      settings: presentSettings(await db.first('SELECT * FROM user_settings WHERE user_id = ?', [userId])),
      wallpaper: await getWallpaperFor(db, userId, tenantId),
      message: 'Setup complete. Welcome to DexterOS.',
    },
    cookies: [session.cookie],
  };
}

export const routes = {
  /** Public status: what is wired up, what still needs configuring. */
  'GET /status': {
    auth: 'none',
    handler: async ({ request, env }) => {
      const body = await deploymentStatus(env);
      // The setup key never leaves the server; expose only whether it is configured.
      return { body: { ...body, setup_key_configured: !!str(env.SETUP_KEY, 200) } };
    },
  },

  /** Public health probe (no database access). */
  'GET /health': {
    auth: 'none',
    handler: async ({ env }) => {
      const d1 = resolveD1Binding(env);
      const r2 = resolveR2Binding(env);
      return {
        body: {
          ok: true,
          service: 'DexterOS',
          version: '3.0',
          runtime: 'cloudflare-pages-functions',
          database: d1 ? { binding: d1.name } : { mode: 'unconfigured' },
          storage: r2 ? { binding: r2.name } : { mode: mediaAvailability(env).mode },
          time: nowIso(),
        },
      };
    },
  },

  /** Creates the schema explicitly (the API does it lazily too; handy for CI). */
  'POST /schema': {
    auth: 'none',
    handler: async ({ request, env }) => {
      const { db } = getDb(env);
      let settings = null;
      try {
        settings = await db.first("SELECT value FROM app_settings WHERE key = 'initialized_at'");
      } catch { /* schema missing */ }
      assertSetupAccess(request, env, settings ? { initialized: true } : { initialized: false });
      await ensureSchema(db);
      return { body: { ok: true, schema_version: SCHEMA_VERSION, message: 'Schema is ready.' } };
    },
  },

  /**
   * First-run setup: creates the first workspace and its owner account.
   * Runs exactly once per deployment — before that, the API refuses registrations.
   */
  /**
   * First-run setup: creates the first workspace and its owner account.
   * Runs exactly once per deployment — before that, the API refuses registrations.
   *
   * The body is executed step by step so a failure names the step that broke and
   * is remembered for the next visit to /setup.
   */
  'POST /setup': {
    auth: 'none',
    handler: async ({ request, env }) => {
      let db = null;
      try {
        db = getDb(env).db;
        const result = await createFirstWorkspace(db, env, request);
        await saveSettings(db, { setup_last_error: '', setup_last_error_at: '' });
        return result;
      } catch (error) {
        if (db && (!(error instanceof HttpError) || error.status >= 500)) await recordSetupError(db, error);
        throw asSetupError(error);
      }
    },
  },

  /**
   * Deployment self-test. Answers "what exactly is broken here?" on a brand new
   * deployment without needing a session: it checks the bindings, the schema, a
   * write round-trip, the password hashing the runtime can afford, and R2.
   * Once the deployment has accounts, the SETUP_KEY secret is required.
   */
  'POST /diagnostics': {
    auth: 'none',
    handler: async ({ request, env }) => {
      const checks = [];
      const tripped = (id, label, error, ms = null) => {
        checks.push({ id, label, ok: false, detail: String(error?.message || error).slice(0, 400), ms });
      };

      let db = null;
      let bindingName = null;
      try {
        const resolved = getDb(env);
        db = resolved.db;
        bindingName = resolved.binding;
        const started = Date.now();
        const probe = await db.first('SELECT 1 AS ok');
        checks.push({
          id: 'database',
          label: 'D1 database binding',
          ok: probe?.ok === 1,
          detail: `Answered "SELECT 1" through the "${bindingName}" binding.`,
          ms: Date.now() - started,
        });
      } catch (error) {
        tripped('database', 'D1 database binding', error);
      }

      let settings = null;
      if (db) {
        try {
          settings = await loadSettings(db, env);
        } catch { /* reported by the schema check below */ }
        await rateLimit(db, `diagnostics:${clientIp(request)}`, { limit: 20, windowMs: 300_000 });
      }
      assertSetupAccess(request, env, settings);

      if (db) {
        const started = Date.now();
        try {
          await ensureSchema(db);
          const row = await db.first("SELECT value FROM app_settings WHERE key = 'schema_version'");
          checks.push({
            id: 'schema',
            label: 'Database schema',
            ok: !!row?.value,
            detail: row?.value ? `Schema version ${row.value} is in place.` : 'The schema version row is missing.',
            ms: Date.now() - started,
          });
        } catch (error) {
          tripped('schema', 'Database schema', error, Date.now() - started);
        }

        const writeStarted = Date.now();
        try {
          const stamp = nowIso();
          await db.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES ('diagnostics_probe', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [stamp, stamp]
          );
          const row = await db.first("SELECT value FROM app_settings WHERE key = 'diagnostics_probe'");
          await db.run("DELETE FROM app_settings WHERE key = 'diagnostics_probe'");
          checks.push({
            id: 'write',
            label: 'Database write access',
            ok: !!row,
            detail: 'Created, read back and deleted a test row.',
            ms: Date.now() - writeStarted,
          });
        } catch (error) {
          tripped('write', 'Database write access', error, Date.now() - writeStarted);
        }
      }

      const hashStarted = Date.now();
      try {
        configureHashing(env);
        const testPassword = 'Diagnostics-Passw0rd!';
        const hash = await hashPassword(testPassword);
        if (!(await verifyPassword(testPassword, hash))) throw new Error('The stored hash did not verify.');
        const profile = hashingProfile();
        const downgraded = profile.used < profile.requested;
        checks.push({
          id: 'password',
          label: 'Password hashing (PBKDF2-SHA256)',
          ok: true,
          detail: `Hashed and verified a test password with ${profile.used.toLocaleString()} iterations in this runtime.`
            + (downgraded ? ` The runtime rejected ${profile.requested.toLocaleString()} iterations, so the safer supported count was used — sign-in works either way.` : ''),
          ms: Date.now() - hashStarted,
        });
      } catch (error) {
        tripped('password', 'Password hashing (PBKDF2-SHA256)', error, Date.now() - hashStarted);
      }

      const storage = mediaAvailability(env);
      if (storage.available) {
        const started = Date.now();
        const key = `diagnostics/${Date.now().toString(36)}.txt`;
        try {
          const value = 'dexteros-diagnostics';
          await putObject(env, key, value, 'text/plain');
          const object = await getObject(env, key);
          const readBack = object ? await new Response(object.body).text() : '';
          await deleteObject(env, key);
          checks.push({
            id: 'storage',
            label: 'R2 storage binding',
            ok: readBack === value,
            detail: readBack === value
              ? `Wrote, read back and deleted a test object through the "${storage.binding}" binding.`
              : 'The bucket did not return what was written.',
            ms: Date.now() - started,
          });
        } catch (error) {
          tripped('storage', 'R2 storage binding', error, Date.now() - started);
        }
      } else {
        tripped('storage', 'R2 storage binding', { message: storage.message });
      }

      let lastSetupError = null;
      if (db) {
        const row = await db.first("SELECT value FROM app_settings WHERE key = 'setup_last_error'").catch(() => null);
        lastSetupError = row?.value || null;
      }

      const failed = checks.filter((c) => !c.ok).length;
      return {
        body: {
          ok: failed === 0,
          checks,
          failed,
          environment: {
            service: settings?.service_name || 'DexterOS',
            runtime: 'cloudflare-pages-functions',
            schema_version: SCHEMA_VERSION,
            database_binding: bindingName,
            storage_binding: storage.binding || null,
            setup_required: !settings?.initialized,
          },
          setup_last_error: lastSetupError,
          summary: failed === 0
            ? 'Every check passed — create the first workspace below.'
            : `${failed} check${failed === 1 ? '' : 's'} need attention. Fix them in the Cloudflare dashboard, redeploy if you changed a binding, then run the self-test again.`,
        },
      };
    },
  },
};
