/**
 * DexterOS — authentication.
 *
 * • Passwords: PBKDF2-HMAC-SHA256 via WebCrypto, stored as
 *   `pbkdf2$<iterations>$<salt>$<hash>` — never reversible, salted per user.
 *   The iteration count is capped at what the runtime actually accepts: the
 *   Cloudflare Workers runtime rejects PBKDF2 above 100 000 iterations with a
 *   `NotSupportedError`, so a higher request would break every sign-in. The count
 *   that was really used is stored inside each hash, and verification reads it
 *   from there, so hashes created at different counts keep working.
 * • Sessions: opaque 256-bit random tokens kept in the `sessions` table and sent
 *   as an HttpOnly cookie and/or an Authorization: Bearer header.
 *
 * WebCrypto has no synchronous verification, so every guard is async.
 */
import { HttpError, base64ToBytes, bytesToBase64, randomToken, timingSafeEqual } from './util.js';
import { SESSION_COOKIE, buildSessionCookie, clearedSessionCookie, getCookie } from './http.js';

export const SESSION_TTL_DAYS = 7;
const KEY_BYTES = 32;

/**
 * Highest iteration count the Cloudflare Workers runtime accepts for WebCrypto
 * PBKDF2. Raising this above the runtime's limit makes `deriveBits` throw
 * NotSupportedError — which is indistinguishable from "something went wrong"
 * unless it is handled, so it is handled here.
 */
export const MAX_PBKDF2_ITERATIONS = 100_000;
const MIN_PBKDF2_ITERATIONS = 10_000;

let configuredIterations = MAX_PBKDF2_ITERATIONS;
let lastUsedIterations = null;

/** Applies the deployment's PBKDF2_ITERATIONS (if any) to this isolate. */
export function configureHashing(env) {
  const requested = Number.parseInt(env?.PBKDF2_ITERATIONS ?? '', 10);
  configuredIterations = Number.isFinite(requested)
    ? Math.min(Math.max(requested, MIN_PBKDF2_ITERATIONS), MAX_PBKDF2_ITERATIONS)
    : MAX_PBKDF2_ITERATIONS;
  return configuredIterations;
}

/** What hashing actually did last time — surfaced by the diagnostics self-test. */
export const hashingProfile = () => ({ requested: configuredIterations, used: lastUsedIterations ?? configuredIterations });

const encoder = new TextEncoder();

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

/**
 * Hashes a password, stepping the iteration count down if the runtime refuses
 * the configured one (so a stricter runtime can never take authentication down).
 */
export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const counts = [];
  for (let count = configuredIterations; count >= MIN_PBKDF2_ITERATIONS; count = Math.floor(count / 2)) counts.push(count);
  if (counts[counts.length - 1] !== MIN_PBKDF2_ITERATIONS) counts.push(MIN_PBKDF2_ITERATIONS);

  let lastError = null;
  for (const iterations of counts) {
    try {
      const hash = await derive(password, salt, iterations);
      lastUsedIterations = iterations;
      return `pbkdf2$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
    } catch (error) {
      // Only iteration-count refusals are retried; anything else is a real fault.
      const refused = error?.name === 'NotSupportedError' || /iteration/i.test(String(error?.message || ''));
      if (!refused) throw error;
      lastError = error;
    }
  }
  throw new HttpError(500, `Password hashing is unavailable in this runtime: ${lastError?.message || 'no supported iteration count'}`, 'HASHING_UNAVAILABLE');
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterationsRaw, saltRaw, hashRaw] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = Number.parseInt(iterationsRaw, 10);
    if (!Number.isFinite(iterations) || iterations < 1000) return false;
    const expected = base64ToBytes(hashRaw);
    const actual = await derive(password, base64ToBytes(saltRaw), iterations);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ sessions */

export function extractToken(request) {
  const auth = request.headers.get('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const custom = request.headers.get('x-session-token');
  if (custom) return custom.trim();
  return getCookie(request, SESSION_COOKIE);
}

export async function createSession(db, user, request, { ip = null, userAgent = null } = {}) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5);
  await db.run(
    `INSERT INTO sessions (token, user_id, tenant_id, user_agent, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [token, user.id, user.tenant_id, (userAgent || '').slice(0, 250), (ip || '').slice(0, 60), new Date().toISOString(), expires.toISOString()]
  );
  return { token, expires: expires.toISOString(), cookie: buildSessionCookie(token, expires) };
}

export const destroySession = (db, token) => (token ? db.run('DELETE FROM sessions WHERE token = ?', [token]) : Promise.resolve());
export const destroyUserSessions = (db, userId) => db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
export const clearedCookie = () => clearedSessionCookie();

/**
 * Resolves the signed-in user for a request. Returns null for anonymous visitors;
 * throws only when a *valid* session belongs to a disabled account or workspace.
 */
export async function loadSession(db, request) {
  const token = extractToken(request);
  if (!token) return null;
  const row = await db.first(
    `SELECT s.token, s.expires_at,
            u.id, u.tenant_id, u.name, u.email, u.role, u.status,
            u.avatar_type, u.avatar_value, u.title, u.phone, u.verified,
            u.last_login_at, u.created_at,
            t.name AS tenant_name, t.slug AS tenant_slug, t.join_code, t.plan,
            t.status AS tenant_status, t.allow_join, t.max_users, t.created_at AS tenant_created_at
       FROM sessions s
       JOIN users u   ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token = ?`,
    [token]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(db, token);
    return null;
  }
  if (row.status !== 'active') {
    await destroySession(db, token);
    throw new HttpError(403, 'This account has been suspended by an administrator.', 'ACCOUNT_DISABLED');
  }
  if (row.tenant_status !== 'active') {
    await destroySession(db, token);
    throw new HttpError(403, 'This workspace is suspended. Please contact an administrator.', 'WORKSPACE_SUSPENDED');
  }
  return {
    token: row.token,
    user: {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      email: row.email,
      role: row.role,
      status: row.status,
      avatar_type: row.avatar_type,
      avatar_value: row.avatar_value,
      title: row.title,
      phone: row.phone,
      verified: row.verified,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
    },
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      slug: row.tenant_slug,
      join_code: row.join_code,
      plan: row.plan,
      status: row.tenant_status,
      allow_join: row.allow_join,
      max_users: row.max_users,
      created_at: row.tenant_created_at,
    },
  };
}

export const isAdmin = (user) => !!user && (user.role === 'admin' || user.role === 'owner');

export function requireAuth(session) {
  if (!session) throw new HttpError(401, 'Please sign in to continue.', 'UNAUTHENTICATED');
  return session;
}

export function requireAdmin(session) {
  requireAuth(session);
  if (!isAdmin(session.user)) throw new HttpError(403, 'Administrator access is required for this action.', 'FORBIDDEN');
  return session;
}

/** Constant-time comparison helper used for setup keys and similar secrets. */
export const safeEqual = timingSafeEqual;
export const decodeBase64 = base64ToBytes;
