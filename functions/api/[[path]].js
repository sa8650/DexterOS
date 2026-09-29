/**
 * DexterOS — API router (Pages Function).
 *
 * One entry point for /api/*: it resolves the workspace context (database +
 * configuration), matches the request against the route tables in src/routes/,
 * enforces authentication and turns anything thrown into a JSON error response.
 *
 * Adding an endpoint never requires touching this file's logic — only the
 * route table it mounts.
 */
import { errorResponse, json, noContent, pruneRateLimits } from '../../src/lib/http.js';
import { HttpError, timingSafeEqual } from '../../src/lib/util.js';
import { getContext } from '../../src/lib/context.js';
import { loadSession, isAdmin } from '../../src/lib/auth.js';
import { deploymentStatus } from '../../src/routes/system.js';

import { routes as authRoutes } from '../../src/routes/auth.js';
import { routes as meRoutes } from '../../src/routes/me.js';
import { routes as portalRoutes } from '../../src/routes/portal.js';
import { routes as adminRoutes } from '../../src/routes/admin.js';
import { routes as systemRoutes } from '../../src/routes/system.js';

const MOUNTS = [
  { prefix: 'system', routes: systemRoutes },
  { prefix: 'auth', routes: authRoutes },
  { prefix: 'me', routes: meRoutes },
  { prefix: 'portal', routes: portalRoutes },
  { prefix: 'admin', routes: adminRoutes },
];

/** Compiles "apps/:id/launch" into a matcher. */
function compile(pattern) {
  const parts = pattern === '/' ? [] : pattern.replace(/^\/+|\/+$/g, '').split('/');
  return (segments) => {
    if (segments.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
      else if (part !== segments[i]) return null;
    }
    return params;
  };
}

const compiled = [];
for (const mount of MOUNTS) {
  for (const [key, definition] of Object.entries(mount.routes)) {
    const space = key.indexOf(' ');
    const method = key.slice(0, space).toUpperCase();
    const pattern = key.slice(space + 1).trim();
    compiled.push({ mount: mount.prefix, method, pattern, match: compile(pattern), definition });
  }
}

/** Segments after the mount prefix, e.g. ['apps', '12', 'launch']. */
function splitPath(pathValue) {
  const segments = Array.isArray(pathValue)
    ? pathValue
    : String(pathValue || '').split('/');
  return segments.map((s) => String(s)).filter(Boolean);
}

function methodLabel(request) {
  return request.method.toUpperCase();
}

/** Cookie + body serialisation of a route result. */
function toResponse(result) {
  if (result instanceof Response) return result;
  if (!result) return noContent();
  const headers = {};
  if (result.cookies?.length) headers['set-cookie'] = result.cookies;
  if (result.clearCookie) {
    const cleared = 'dexteros_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
    headers['set-cookie'] = headers['set-cookie'] ? [...headers['set-cookie'], cleared] : cleared;
  }
  if (result.status === 204) return noContent(headers);
  return json(result.body ?? {}, { status: result.status ?? 200, headers });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = methodLabel(request);
  const segments = splitPath(params?.path);

  // Preflight: same-origin only, but answer politely.
  if (method === 'OPTIONS') {
    return noContent({ allow: 'GET,HEAD,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-setup-key' });
  }

  try {
    if (!segments.length) {
      return json({
        service: 'DexterOS API',
        version: '3.0',
        endpoints: ['/api/system/status', '/api/system/health', '/api/system/setup', '/api/auth/*', '/api/me/*', '/api/portal/*', '/api/admin/*'],
      });
    }

    const mount = segments[0];
    const rest = segments.slice(1);
    const mountRoutes = MOUNTS.find((m) => m.prefix === mount);
    if (!mountRoutes) throw new HttpError(404, 'Unknown API endpoint.', 'NOT_FOUND');
    if (mount === 'system') return handleSystem(context, request, env, rest, method);

    const candidates = compiled.filter((entry) => entry.mount === mount);
    let matched = null;
    for (const entry of candidates) {
      if (entry.method !== method) continue;
      const routeParams = entry.match(rest);
      if (routeParams !== null) { matched = { entry, routeParams }; break; }
    }
    if (!matched) {
      const pathExists = candidates.some((entry) => entry.match(rest) !== null);
      throw new HttpError(
        pathExists ? 405 : 404,
        pathExists ? `${method} is not allowed on this endpoint.` : 'Unknown API endpoint.',
        pathExists ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND'
      );
    }

    const { entry, routeParams } = matched;
    const definition = entry.definition;
    const context_ = await getContext(env);
    const needsSession = definition.auth !== 'none';
    const session = needsSession ? await loadSession(context_.db, request) : null;

    if (definition.auth === 'user' && !session) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
    if (definition.auth === 'admin') {
      if (!session) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
      if (!isAdmin(session.user)) throw new HttpError(403, 'Administrator access is required for this action.', 'FORBIDDEN');
    }

    // Occasional housekeeping, cheap enough to piggyback on normal traffic.
    if (Math.random() < 0.02) await pruneRateLimits(context_.db);

    const result = await definition.handler({
      request,
      env,
      url: new URL(request.url),
      params: routeParams,
      session,
      user: session?.user || null,
      tenant: session?.tenant || null,
      settings: context_.settings,
      media: context_.media,
      db: context_.db,
      dbMode: context_.dbMode,
      context: context_,
    });
    return toResponse(result);
  } catch (error) {
    return errorResponse(error, { expose: await shouldExposeDetail(request, env) });
  }
}

/**
 * True while there is nothing to protect yet: either the caller proved it holds
 * the SETUP_KEY secret, or the deployment has no accounts at all. Only then are
 * technical error details included in the response.
 */
async function shouldExposeDetail(request, env) {
  const expected = String(env?.SETUP_KEY || '');
  const provided = request.headers.get('x-setup-key') || '';
  if (expected && provided && timingSafeEqual(provided, expected)) return true;
  try {
    const { getDb } = await import('../../src/lib/db.js');
    const { db } = getDb(env);
    const row = await db.first('SELECT COUNT(*) AS n FROM users');
    return (row?.n ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * /api/system/* works even when no database is bound yet, because its whole job
 * is to explain what still needs to be configured in the Cloudflare dashboard.
 */
async function handleSystem(context, request, env, rest, method) {
  const path = rest.join('/');

  // Liveness probe: answers even when nothing is bound, so uptime monitors and
  // the setup page always get a response.
  if (method === 'GET' && path === 'health') {
    const { resolveD1Binding, resolveR2Binding } = await import('../../src/lib/db.js');
    const { mediaAvailability } = await import('../../src/lib/media.js');
    const d1 = resolveD1Binding(env);
    const r2 = resolveR2Binding(env);
    return json({
      ok: true,
      service: 'DexterOS',
      version: '3.0',
      runtime: 'cloudflare-pages-functions',
      database: d1 ? { binding: d1.name } : { mode: 'unconfigured' },
      storage: r2 ? { binding: r2.name } : { mode: mediaAvailability(env).mode },
      time: new Date().toISOString(),
    });
  }

  if (method === 'GET' && path === 'status') {
    try {
      const status = await deploymentStatus(env);
      return json({ ...status, setup_key_configured: Boolean(env.SETUP_KEY) });
    } catch (error) {
      return errorResponse(error, { expose: await shouldExposeDetail(request, env) });
    }
  }

  // Self-test: answered before any database is required, so it can *explain* a
  // missing binding instead of failing with one.
  if (method === 'POST' && path === 'diagnostics') {
    try {
      const result = await systemRoutes['POST /diagnostics'].handler({ request, env, url: new URL(request.url), params: {} });
      return toResponse(result);
    } catch (error) {
      return errorResponse(error, { expose: await shouldExposeDetail(request, env) });
    }
  }

  try {
    const context_ = await getContext(env);
    const session = await loadSession(context_.db, request);
    const entries = Object.entries(systemRoutes);
    for (const [key, definition] of entries) {
      const space = key.indexOf(' ');
      const routeMethod = key.slice(0, space).toUpperCase();
      const pattern = key.slice(space + 1).trim();
      if (routeMethod !== method) continue;
      const match = compile(pattern)(rest);
      if (match === null) continue;
      const result = await definition.handler({
        request,
        env,
        url: new URL(request.url),
        params: match,
        session,
        user: session?.user || null,
        tenant: session?.tenant || null,
        settings: context_.settings,
        media: context_.media,
        db: context_.db,
        context: context_,
      });
      return toResponse(result);
    }
    throw new HttpError(404, 'Unknown system endpoint.', 'NOT_FOUND');
  } catch (error) {
    return errorResponse(error, { expose: await shouldExposeDetail(request, env) });
  }
}
