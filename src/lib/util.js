/**
 * DexterOS — validation and formatting helpers (identical rules on every route).
 */

export const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code) => new HttpError(400, message, code);
export const unauthorized = (message = 'Please sign in to continue.', code = 'UNAUTHENTICATED') => new HttpError(401, message, code);
export const forbidden = (message = 'You do not have access to this resource.', code = 'FORBIDDEN') => new HttpError(403, message, code);
export const notFound = (message = 'Not found.', code = 'NOT_FOUND') => new HttpError(404, message, code);
export const conflict = (message, code) => new HttpError(409, message, code);

/** Strings are trimmed and capped; everything else becomes ''. */
export const str = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
export const isValidEmail = (value) => typeof value === 'string' && value.length <= 190 && EMAIL_RE.test(value.trim());
export const normalizeEmail = (value) => str(value, 190).toLowerCase();

/** Production password policy: >= 10 chars, at least one letter and one digit. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters long.';
  if (pw.length > 200) return 'Password must be shorter than 200 characters.';
  if (!/[A-Za-z]/.test(pw)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  // Only genuinely weak choices are rejected: the classic "password123" style
  // secrets. Everything is compared after stripping separators so that
  // "Str0ng-Password!" is not punished for containing a dictionary word.
  const weak = [
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'passwords',
    'qwerty', 'qwertyuiop', 'qwerty123', 'letmein', 'letmein123', 'welcome1', 'welcome123',
    'admin', 'admin123', 'administrator', 'iloveyou', 'abc12345', '123456789', '1234567890',
    'changeme', 'changeme123', 'secret123', 'dexteros', 'dexteros123',
  ];
  const normalized = pw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const collapsed = normalized.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
  if (weak.includes(normalized) || weak.includes(collapsed)) {
    return 'That password is too common. Choose something unique.';
  }
  return null;
}

/**
 * Only absolute http(s) URLs are accepted — this blocks javascript:, data:,
 * vbscript: and every other scheme that could be executed in the browser.
 */
export function safeUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null; // scheme without // → reject
    candidate = `https://${candidate}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || !url.hostname.includes('.')) return null;
  if (url.username || url.password) return null;
  const normalized = url.toString();
  return url.pathname === '/' && !url.search && !url.hash ? normalized.slice(0, -1) : normalized;
}

/** Allows app-internal asset paths (/media/...) as well as absolute URLs. */
export function safeAssetRef(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('<') && !raw.includes('\\')) return raw.slice(0, 500);
  return safeUrl(raw);
}

export const SVG_OR_IMG_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/svg+xml']);

export const slugify = (input = '') =>
  String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/** Human friendly workspace join code, e.g. DX-7F3K9Q (crypto randomness). */
export function joinCode(prefix = 'DX') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'DX'}-${out}`;
}

export const randomToken = (bytes = 32) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const bytesToBase64 = (bytes) => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const base64ToBytes = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Constant-time-ish string comparison (length leak only). */
export function timingSafeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export const humanBytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(n) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
