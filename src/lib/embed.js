/**
 * DexterOS — frame-embedding probe.
 *
 * Some sites forbid being displayed in a frame (X-Frame-Options / CSP
 * frame-ancestors). Instead of showing a blank window, DexterOS checks once per
 * URL, caches the verdict in D1 and tells the user exactly what happened.
 *
 * The probe only ever fetches URLs that are already configured as apps in the
 * caller's own workspace, so it cannot be abused as an open proxy.
 */
import { nowIso } from './util.js';

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export function analyseHeaders(headers, status) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('deny')) {
    return { embeddable: 0, reason: 'The site sends X-Frame-Options: DENY, so browsers refuse to render it inside a frame.' };
  }
  if (xfo.includes('sameorigin')) {
    return { embeddable: 0, reason: 'The site only allows being framed by its own origin (X-Frame-Options: SAMEORIGIN).' };
  }
  const csp = headers.get('content-security-policy') || '';
  const match = csp.match(/frame-ancestors([^;]*)/i);
  if (match) {
    const value = match[1].trim().toLowerCase();
    if (value.includes("'none'")) {
      return { embeddable: 0, reason: "The site forbids framing for every origin (frame-ancestors 'none')." };
    }
    if (value.includes("'self'") && !value.includes('*') && !value.includes('http')) {
      return { embeddable: 0, reason: "The site restricts framing to its own origin (frame-ancestors 'self')." };
    }
  }
  if (status >= 400) {
    return { embeddable: null, reason: `The site answered with HTTP ${status} while probing; embedding may still work for you.` };
  }
  return { embeddable: 1, reason: 'No framing restrictions were detected.' };
}

async function fetchProbe(url, method = 'GET') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DexterOS/3.0 embed-probe)',
        accept: 'text/html,application/xhtml+xml,*/*',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{embeddable: 0|1|null, reason: string, status: number|null, checked_at: string, cached: boolean}>}
 */
export async function probeEmbed(db, url, { force = false } = {}) {
  if (!force) {
    const cached = await db.first('SELECT * FROM embed_cache WHERE url = ?', [url]);
    if (cached && Date.now() - new Date(cached.checked_at).getTime() < CACHE_TTL_MS) {
      return { embeddable: cached.embeddable, reason: cached.reason, status: cached.status_code, checked_at: cached.checked_at, cached: true };
    }
  }

  let result = { embeddable: null, reason: 'The site could not be reached for the embed check.', status: null };
  try {
    let response = await fetchProbe(url, 'GET');
    if (response.status === 405 || response.status === 501) response = await fetchProbe(url, 'HEAD');
    const analysis = analyseHeaders(response.headers, response.status);
    result = { ...analysis, status: response.status };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    result = {
      embeddable: null,
      reason: aborted ? 'The site took too long to answer the embed check.' : 'The site could not be reached for the embed check.',
      status: null,
    };
  }

  const checkedAt = nowIso();
  await db.run(
    `INSERT INTO embed_cache (url, embeddable, reason, status_code, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET embeddable = excluded.embeddable, reason = excluded.reason,
                                    status_code = excluded.status_code, checked_at = excluded.checked_at`,
    [url, result.embeddable, result.reason, result.status, checkedAt]
  );
  return { ...result, checked_at: checkedAt, cached: false };
}
