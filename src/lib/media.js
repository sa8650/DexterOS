/**
 * DexterOS — R2 media adapter.
 *
 * Uploaded icons, wallpapers and avatars are stored in the R2 bucket that is
 * bound to the Pages project (variable name "MEDIA" by default). Storage is used
 * exclusively through that binding — no Cloudflare API token is ever involved.
 *
 * Stored objects are addressed through the app's own /media/<key> route, so no
 * bucket name, account id or public bucket URL is required anywhere in the code.
 */
import { HttpError, base64ToBytes, bytesToBase64, str } from './util.js';
import { resolveR2Binding } from './db.js';

export function mediaAvailability(env) {
  const bound = resolveR2Binding(env);
  if (bound) return { available: true, mode: 'binding', binding: bound.name };
  return {
    available: false,
    mode: 'unconfigured',
    binding: null,
    message:
      'File uploads are disabled because no R2 bucket is connected. Open Cloudflare → Workers & Pages → your Pages project → '
      + 'Settings → Functions → R2 bucket bindings, add a binding whose variable name is "MEDIA" and points at your bucket, '
      + 'then redeploy. No API token is needed.',
  };
}

export async function putObject(env, key, body, contentType) {
  const bound = resolveR2Binding(env);
  if (bound) {
    await bound.binding.put(key, body, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    return { key, mode: 'binding' };
  }
  throw new HttpError(
    503,
    'Storage is not connected. Add an R2 bucket binding named "MEDIA" to your Pages project (Settings → Functions → R2 bucket bindings).',
    'R2_NOT_CONFIGURED'
  );
}

/** Returns { body: ReadableStream, contentType, size, etag } or null. */
export async function getObject(env, key) {
  const bound = resolveR2Binding(env);
  if (bound) {
    const object = await bound.binding.get(key);
    if (!object) return null;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    return { body: object.body, contentType: headers.get('content-type') || 'application/octet-stream', size: object.size, etag: object.httpEtag };
  }
  return null;
}

export async function deleteObject(env, key) {
  if (!key) return false;
  const bound = resolveR2Binding(env);
  if (bound) {
    await bound.binding.delete(key);
    return true;
  }
  return false;
}

/** Public URL for a stored object: our own /media route (or an R2 custom domain). */
export function publicUrlFor(env, key) {
  const base = str(env.R2_PUBLIC_BASE_URL, 300).replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `/media/${key}`;
}

const EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
]);

export const ALLOWED_IMAGE_TYPES = [...EXTENSIONS.keys()];

export function extensionFor(contentType) {
  return EXTENSIONS.get(String(contentType || '').toLowerCase()) || null;
}

/** Random, namespaced object key: t/<tenant>/<kind>/<random>.<ext> */
export function objectKey(tenantId, kind, contentType) {
  const ext = extensionFor(contentType) || 'bin';
  const random = new Uint8Array(12);
  crypto.getRandomValues(random);
  const id = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t${tenantId}/${kind}/${Date.now().toString(36)}-${id}.${ext}`;
}

/* ------------------------------------------------------------------ uploads */

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/**
 * Reads a multipart upload, validates type + size, and stores it in R2.
 * Returns { key, url, size, contentType }.
 */
export async function storeUpload(env, request, { tenantId, kind, maxBytes = MAX_UPLOAD_BYTES }) {
  const availability = mediaAvailability(env);
  if (!availability.available) throw new HttpError(503, availability.message, 'R2_NOT_CONFIGURED');

  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'Expected a multipart/form-data upload.', 'BAD_UPLOAD');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Choose a file to upload (form field "file").', 'BAD_UPLOAD');

  const contentType = str(file.type, 80).toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new HttpError(400, 'Unsupported file type. Use PNG, JPG, WEBP, AVIF, GIF or SVG.', 'BAD_UPLOAD_TYPE');
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) throw new HttpError(400, 'That file is empty.', 'BAD_UPLOAD');
  if (buffer.byteLength > maxBytes) {
    throw new HttpError(413, `That file is too large. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'UPLOAD_TOO_LARGE');
  }

  const key = objectKey(tenantId, kind, contentType);
  await putObject(env, key, buffer, contentType);
  return { key, url: publicUrlFor(env, key), size: buffer.byteLength, contentType, fields: form };
}

export const base64 = { from: base64ToBytes, to: bytesToBase64 };
