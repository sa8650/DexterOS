/* ==========================================================================
   DexterOS — shared front-end toolkit (API client, storage, UI helpers)
   Loaded by the landing page, the desktop console and the admin console.
   ========================================================================== */
(function () {
  'use strict';

  const TOKEN_KEY = 'dexteros.token';

  const store = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    set token(value) { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); },
    clear() { localStorage.removeItem(TOKEN_KEY); },
  };

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  async function request(path, { method = 'GET', body, raw, signal } = {}) {
    const headers = {};
    if (store.token) headers.authorization = `Bearer ${store.token}`;
    let payload;
    if (raw) payload = raw;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      res = await fetch(path, { method, headers, body: payload, signal, credentials: 'same-origin' });
    } catch (err) {
      throw new ApiError('Network problem — could not reach DexterOS.', 0, 'NETWORK');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const message = (json && json.error) || `Request failed (${res.status})`;
      if (res.status === 401 && !location.pathname.startsWith('/login')) store.clear();
      const failure = new ApiError(message, res.status, json && json.code);
      // Present only while the deployment has no accounts yet / with SETUP_KEY:
      // the technical cause of a server error, so first-run problems are fixable.
      if (json && json.detail) failure.detail = json.detail;
      if (json && json.reference) failure.reference = json.reference;
      throw failure;
    }
    return json;
  }

  const api = {
    get: (p, opts) => request(p, opts),
    post: (p, body, opts) => request(p, { ...opts, method: 'POST', body }),
    patch: (p, body, opts) => request(p, { ...opts, method: 'PATCH', body }),
    del: (p, body, opts) => request(p, { ...opts, method: 'DELETE', body }),
    upload: (p, file, fields = {}, method = 'POST') => {
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      return request(p, { method, raw: fd });
    },
    ApiError, store,
  };

  /* ---------------------------------------------------------------- markup */
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Renders an app icon tile (database icon: emoji | image | letter). */
  function appIcon(app, size) {
    const icon = app.icon || {};
    const dim = size ? `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.52)}px;` : '';
    const bg = icon.bg ? `background:${esc(icon.bg)};` : '';
    if (icon.type === 'image' && icon.value) {
      // Broken icon images fall back to the app's initial (handled by the delegated error listener below).
      return `<span class="appicon" style="${dim}${bg}" data-fallback="${esc((app.name || '?').slice(0, 1).toUpperCase())}"><img src="${esc(icon.value)}" alt="" loading="lazy"></span>`;
    }
    if (icon.type === 'letter') {
      return `<span class="appicon letter" style="${dim}${bg}">${esc(String(icon.value || app.name || '?').slice(0, 1).toUpperCase())}</span>`;
    }
    return `<span class="appicon" style="${dim}${bg}">${esc(icon.value || '📦')}</span>`;
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }

  /** Renders a user avatar (letter | emoji | uploaded image) at a given size class. */
  function avatar(user, cls = '') {
    const a = (user && user.avatar) || {};
    const name = (user && user.name) || '';
    if (a.type === 'image' && a.value) {
      return `<span class="avatar ${cls}" style="background-image:url('${esc(a.value)}')" title="${esc(name)}"></span>`;
    }
    if (a.type === 'emoji' && a.value) {
      return `<span class="avatar ${cls}" style="background:color-mix(in srgb, var(--accent) 22%, transparent)">${esc(a.value)}</span>`;
    }
    return `<span class="avatar ${cls}" title="${esc(name)}">${esc(initials(name))}</span>`;
  }

  /* ---------------------------------------------------------------- ui bits */
  function toast(message, { title = 'DexterOS', type = 'info', timeout = 4200 } = {}) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<strong>${esc(title)}</strong><span>${esc(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s ease, transform .2s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  const toastOk = (msg, title) => toast(msg, { title: title || 'Done', type: 'success' });
  const toastErr = (msg, title) => toast(msg, { title: title || 'Something went wrong', type: 'error', timeout: 6000 });

  /** Simple promise-based modal. `render(body)` returns HTML; `onMount(root, close)` wires it up. */
  function modal({ title, body, footer = '', wide = false, onMount, onClose }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header><h3>${esc(title)}</h3><button class="btn btn-subtle btn-icon" data-close aria-label="Close">✕</button></header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer>${footer}</footer>` : ''}
      </div>`;
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    const root = backdrop.querySelector('.modal');
    if (onMount) onMount(root, close);
    const focusable = root.querySelector('input, select, textarea, button.btn-primary');
    if (focusable) setTimeout(() => focusable.focus(), 60);
    return { root, close };
  }

  function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value, close) => { settled = true; close(); resolve(value); };
      const { close } = modal({
        title,
        body: `<p class="muted" style="margin:0">${esc(message)}</p>`,
        footer: `<button class="btn" data-close>Cancel</button>
                 <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>`,
        onMount(root, closeFn) {
          root.querySelector('[data-confirm]').addEventListener('click', () => done(true, closeFn));
        },
        onClose() { if (!settled) resolve(false); },
      });
      return close;
    });
  }

  /* ---------------------------------------------------------------- format */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso, withTime = true) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const date = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (!withTime) return date;
    return `${date}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function timeAgo(iso) {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(diff)) return 'never';
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} d ago`;
    return fmtDate(iso, false);
  }

  const humanAction = (action) => String(action || '')
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  /** Pulls the hostname out of a URL for compact display. */
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  // Broken image fallback without inline handlers (CSP friendly).
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (img && img.tagName === 'IMG' && img.parentElement && img.parentElement.classList.contains('appicon')) {
      const tile = img.parentElement;
      if (tile.dataset.fallback) {
        tile.textContent = tile.dataset.fallback;
        delete tile.dataset.fallback;
      }
    }
  }, true);

  window.DX = {
    api, esc, appIcon, avatar, initials, toast, toastOk, toastErr, modal, confirmDialog,
    fmtDate, timeAgo, humanAction, hostOf, store,
  };
}());
