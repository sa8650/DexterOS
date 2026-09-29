/**
 * DexterOS — media delivery (Pages Function).
 *
 * Serves uploaded icons, wallpapers and avatars from the R2 bucket bound to the
 * project, so image URLs stay on your own domain: /media/<key>.
 *
 * Only the methods needed for delivery are implemented; uploads go through the
 * authenticated API (/api/admin/uploads/icon, /api/me/avatar, ...).
 */
import { getObject } from '../../src/lib/media.js';

const IMMUTABLE = 60 * 60 * 24 * 365;

function notFound() {
  return new Response(JSON.stringify({ error: 'Not found.', code: 'MEDIA_NOT_FOUND' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestHead(args) {
  const response = await onRequestGet(args);
  return new Response(null, { status: response.status, headers: response.headers });
}

export async function onRequestGet({ params, env, request }) {
  const segments = Array.isArray(params.path) ? params.path : String(params.path || '').split('/');
  const key = segments.filter(Boolean).map((s) => String(s)).join('/');
  if (!key || key.includes('..')) return notFound();

  try {
    const object = await getObject(env, key);
    if (!object) return notFound();

    const etag = object.etag;
    if (etag && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': `public, max-age=${IMMUTABLE}, immutable` } });
    }

    // Built conditionally: an undefined header value would be sent literally.
    const headers = {
      'content-type': object.contentType || 'application/octet-stream',
      'cache-control': `public, max-age=${IMMUTABLE}, immutable`,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; sandbox",
    };
    if (object.size) headers['content-length'] = String(object.size);
    if (etag) headers.etag = etag;

    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    console.error('[dexteros] media read failed:', error?.message);
    return notFound();
  }
}
