/**
 * DexterOS — HTTP plumbing: JSON responses, security headers, cookies,
 * body parsing and shared rate limiting.
 */
import { HttpError, timingSafeEqual } from './util.js';

export const SESSION_COOKIE = 'dexteros_session';

/** Applied to every API response (static assets get their own headers via _headers). */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cache-control': 'no-store',
};

export function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function noContent(headers = {}) {
  return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...headers } });
}

/**
 * Serialises any thrown value into a safe JSON error response.
 *
 * `expose` is set by the router while a deployment is still uninitialised (or
 * when the caller holds the SETUP_KEY secret): in that window the person reading
 * the message is the operator setting the deployment up, and hiding the cause
 * behind "something went wrong" only costs them an hour of guessing. A live
 * deployment with real accounts never sends internal detail.
 */
export function errorResponse(error, { expose = false } = {}) {
  const status = error instanceof HttpError ? error.status : (error?.status || 500);
  const message = error instanceof HttpError
    ? error.message
    : 'Something went wrong on our side. Please try again.';
  const payload = { error: message };
  if (error instanceof HttpError && error.code) payload.code = error.code;

  if (status >= 500) {
    const reference = shortId();
    payload.reference = reference;
    console.error('[dexteros]', reference, error?.stack || error);
    if (expose) {
      payload.detail = `${error?.name || 'Error'}: ${String(error?.message || error).slice(0, 500)}`;
      payload.hint = 'This deployment has no accounts yet, so the technical cause is included here. '
        + 'Run POST /api/system/diagnostics for a step-by-step self-test.';
    }
  }
  return json(payload, { status });
}

function shortId() {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/** Reads a JSON body defensively (empty, malformed and huge bodies are handled). */
export async function readJson(request, { maxBytes = 1024 * 1024 } = {}) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!type) return {};
    throw new HttpError(415, 'Expected an application/json request body.', 'BAD_CONTENT_TYPE');
  }
  const text = await request.text();
  if (!text) return {};
  if (text.length > maxBytes) throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.', 'BAD_JSON');
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const idx = chunk.indexOf('=');
    if (idx === -1) continue;
    if (chunk.slice(0, idx).trim() === name) return decodeURIComponent(chunk.slice(idx + 1).trim());
  }
  return null;
}

export function buildSessionCookie(token, expires, { secure = true } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearedSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || '0.0.0.0';
}

/**
 * Shared (database-backed) rate limiter — survives across isolates, unlike an
 * in-memory counter. Fails open: a limiter outage must not break sign-in.
 */
export async function rateLimit(db, key, { limit = 20, windowMs = 60_000 } = {}) {
  const now = Date.now();
  try {
    const row = await db.first('SELECT key, window_start, count FROM rate_limits WHERE key = ?', [key]);
    if (!row) {
      await db.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)', [key, now]);
      return { allowed: true, remaining: limit - 1 };
    }
    if (now - row.window_start > windowMs) {
      await db.run('UPDATE rate_limits SET window_start = ?, count = 1 WHERE key = ?', [now, key]);
      return { allowed: true, remaining: limit - 1 };
    }
    const next = row.count + 1;
    await db.run('UPDATE rate_limits SET count = ? WHERE key = ?', [next, key]);
    if (next > limit) {
      const retryAfter = Math.ceil((row.window_start + windowMs - now) / 1000);
      throw new HttpError(429, `Too many attempts. Please wait ${retryAfter} second${retryAfter === 1 ? '' : 's'} and try again.`, 'RATE_LIMITED');
    }
    return { allowed: true, remaining: Math.max(0, limit - next) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn('[dexteros] rate limiter unavailable:', error?.message);
    return { allowed: true, remaining: 0 };
  }
}

/** Occasional cleanup so the counters table cannot grow forever. */
export async function pruneRateLimits(db) {
  const cutoff = Date.now() - 3_600_000;
  try {
    await db.run('DELETE FROM rate_limits WHERE window_start < ?', [cutoff]);
  } catch { /* best effort */ }
}

export const constantTimeEqual = timingSafeEqual;
