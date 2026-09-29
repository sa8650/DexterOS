/* ==========================================================================
   DexterOS — desktop console
   A Windows 11 25H2 inspired shell: wallpaper, app grid, start menu, taskbar and
   a multi-window manager. Everything is loaded from the database via the API.
   ========================================================================== */
(function () {
  'use strict';

  const { api, esc, appIcon, avatar, toast, toastOk, toastErr, modal, confirmDialog, fmtDate, timeAgo, hostOf, store } = window.DX;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    user: null, tenant: null, settings: null, wallpaper: null,
    apps: [], wallpapers: [], recent: [], recommended: [],
    windows: new Map(), z: 100, seq: 0,
    openMaximized: localStorage.getItem('dexteros.openMaximized') === '1',
    confirmClose: localStorage.getItem('dexteros.confirmClose') === '1',
    appsSignature: '',
  };

  const desktopArea = () => {
    const tb = 48;
    return { w: window.innerWidth, h: window.innerHeight - tb };
  };

  /* ================================================================== theme */

  const hexLuma = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 0;
    const int = parseInt(m[1], 16);
    const r = (int >> 16) & 255; const g = (int >> 8) & 255; const b = int & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  function applyAccent(accent) {
    const color = accent || '#2563eb';
    document.documentElement.style.setProperty('--accent', color);
    const onAccent = hexLuma(color) > 0.62 ? '#0b1220' : '#ffffff';
    document.documentElement.style.setProperty('--accent-text', onAccent);
  }

  /** Detects a very light wallpaper so icon labels stay readable. */
  function applyWallpaper(wp) {
    const layer = $('#wallpaper');
    state.wallpaper = wp || null;
    const fallback = 'linear-gradient(160deg, #070b16, #0b1226 55%, #05070f)';
    document.body.dataset.lightWallpaper = '0';
    if (!wp) { layer.style.backgroundImage = fallback; layer.style.background = fallback; return; }

    if (wp.kind === 'css') {
      layer.style.backgroundImage = '';
      layer.style.background = wp.value || fallback;
      const light = /#(f|e|d)[0-9a-f]{2}|#fff/i.test(wp.value || '') || /daylight|light/i.test(wp.name || '');
      document.body.dataset.lightWallpaper = light ? '1' : '0';
      return;
    }
    const url = String(wp.value).replace(/"/g, '%22');
    layer.style.background = '';
    layer.style.backgroundImage = `url("${url}")`;
    layer.style.backgroundSize = 'cover';
    layer.style.backgroundPosition = 'center';
    // Best-effort luminance probe (same-origin uploads work; remote images fall back to the name).
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 12; c.height = 12;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 12, 12);
          const { data } = ctx.getImageData(0, 0, 12, 12);
          let total = 0;
          for (let i = 0; i < data.length; i += 4) total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          const avg = total / (data.length / 4);
          document.body.dataset.lightWallpaper = avg > 0.68 ? '1' : '0';
        } catch { /* tainted canvas — keep heuristic */ }
      };
      img.onerror = () => {};
      img.src = url;
    } catch { /* ignore */ }
    if (/daylight|light|white/i.test(wp.name || '')) document.body.dataset.lightWallpaper = '1';
  }

  function applySettings(settings, { silent = true } = {}) {
    state.settings = { ...state.settings, ...settings };
    const s = state.settings;
    document.documentElement.dataset.theme = s.theme || 'dark';
    document.body.dataset.theme = s.theme || 'dark';
    document.body.dataset.taskbarAlign = s.taskbar_align || 'center';
    document.body.dataset.iconSize = s.icon_size || 'medium';
    document.body.dataset.showLabels = s.show_labels ? '1' : '0';
    document.body.classList.toggle('no-blur', !!s.reduced_transparency);
    applyAccent(s.accent);
    if (!silent) toastOk('Preferences saved.');
  }

  async function savePreferences(patch, { message } = {}) {
    const res = await api.patch('/api/me/preferences', patch);
    applySettings(res.settings);
    if (message) toastOk(message);
    return res;
  }

  /* ================================================================== app grid */

  function renderGrid() {
    const grid = $('#icon-grid');
    if (!state.apps.length) {
      grid.style.display = 'block';
      grid.innerHTML = `
        <div class="grid-empty">
          <h3>This desktop is empty</h3>
          <p>Your workspace administrator has not published any applications yet. The Settings app is always available
             from the taskbar, and administrators can add apps in the admin console.</p>
          <button class="btn btn-primary" data-open-settings>Open Settings</button>
        </div>`;
      return;
    }
    grid.style.display = 'grid';
    grid.innerHTML = state.apps.map((app) => `
      <button class="tile" data-app="${app.id}" title="${esc(app.name)} — ${esc(app.url)}" aria-label="Open ${esc(app.name)}">
        <span class="tile-icon ${app.icon.type === 'letter' ? 'letter' : ''}" ${app.icon.bg ? `style="background:${esc(app.icon.bg)}"` : ''}>${iconInner(app)}</span>
        <span class="tile-label">${esc(app.name)}</span>
      </button>`).join('');
  }

  function iconInner(app) {
    const icon = app.icon || {};
    if (icon.type === 'image' && icon.value) return `<img src="${esc(icon.value)}" alt="" loading="lazy">`;
    if (icon.type === 'letter') return esc(String(icon.value || app.name).slice(0, 1).toUpperCase());
    return esc(icon.value || '📦');
  }

  /* ================================================================== taskbar */

  function renderTaskbar() {
    const center = $('#tb-apps'); // start button + separator stay put; only the app buttons are re-rendered
    const pinned = state.apps.filter((a) => a.is_pinned);
    const extras = state.apps.filter((a) => !a.is_pinned);
    const ordered = [...pinned, ...extras];
    const pinnedIds = new Set(pinned.map((a) => a.id));

    let html = ordered.map((app) => {
      const win = state.windows.get(app.id);
      const classes = ['tb-btn'];
      if (pinnedIds.has(app.id)) classes.push('pinned');
      if (win) classes.push(win.el.classList.contains('minimized') ? 'running' : (win.focused ? 'active' : 'running'));
      return `<button class="${classes.join(' ')}" data-tb-app="${app.id}" title="${esc(app.name)}">
        <span class="tb-icon ${app.icon.type === 'letter' ? 'letter' : ''}" ${app.icon.bg ? `style="background:${esc(app.icon.bg)}"` : ''}>${iconInner(app)}</span>
      </button>`;
    }).join('');

    // Running apps that are not in the visible list (e.g. hidden while open) still get a button.
    for (const [id, win] of state.windows) {
      if (!state.apps.some((a) => a.id === id)) {
        html += `<button class="tb-btn running" data-tb-app="${id}" title="${esc(win.app.name)}">
          <span class="tb-icon">${iconInner(win.app)}</span></button>`;
      }
    }
    center.innerHTML = html;

    const user = state.user || {};
    $('#tb-user-avatar').innerHTML = avatar(user, 'sm');
    const clock = $('#tb-clock');
    const now = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    clock.innerHTML = `<b>${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</b><br>${days[now.getDay()]} ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  }

  /* ================================================================== start menu */

  function renderStart(filter = '') {
    const term = filter.trim().toLowerCase();
    const apps = state.apps.filter((a) => !term || a.name.toLowerCase().includes(term) || (a.category || '').toLowerCase().includes(term));
    const pinned = apps.filter((a) => a.is_pinned);
    const rest = apps.filter((a) => !a.is_pinned);
    const gridApps = pinned.length ? pinned : apps.slice(0, 12);

    const grid = $('#start-grid');
    if (gridApps.length) {
      $('#start-pinned-title').classList.remove('hiddenish');
      grid.classList.remove('hiddenish');
      grid.innerHTML = gridApps.map((app) => `
        <button class="start-app" data-app="${app.id}" title="${esc(app.name)}">
          <span class="sa-icon">${iconInner(app)}</span>
          <span class="sa-label">${esc(app.name)}</span>
        </button>`).join('');
    } else {
      $('#start-pinned-title').classList.add('hiddenish');
      grid.classList.add('hiddenish');
      grid.innerHTML = '';
    }

    const listApps = term ? rest : [...state.recent.map((r) => state.apps.find((a) => a.id === r.id) || r), ...rest].filter(Boolean).slice(0, 8);
    const list = $('#start-list');
    list.innerHTML = listApps.length
      ? listApps.map((app) => `
        <button class="start-row" data-app="${app.id}">
          <span class="sr-icon">${iconInner(app)}</span>
          <span class="sr-meta"><b>${esc(app.name)}</b><span>${esc(app.category || 'App')} · ${esc(hostOf(app.url))}</span></span>
        </button>`).join('')
      : `<p class="tiny muted" style="padding:6px 8px">${term ? 'No apps match your search.' : 'Open an app and it will show up here.'}</p>`;
    $('#start-list-title').textContent = term ? 'Search results' : 'Recently used';

    const user = state.user || {};
    $('#start-user').innerHTML = `
      ${avatar(user, '')}
      <span><b>${esc(user.name || '')}</b><span>${esc(user.email || '')}</span></span>`;
    $('#start-admin-link').classList.toggle('hiddenish', !(user.role === 'admin' || user.role === 'owner'));
    $('#start-workspace').textContent = (state.tenant && state.tenant.name) || '';
  }

  function toggleStart(force) {
    const menu = $('#start-menu');
    const open = force === undefined ? !menu.classList.contains('open') : force;
    menu.classList.toggle('open', open);
    if (open) {
      renderStart($('#start-search').value || '');
      setTimeout(() => $('#start-search').focus(), 60);
    } else {
      $('#start-search').value = '';
      closeFlyout();
    }
  }

  function closeFlyout() {
    $('#start-flyout')?.remove();
  }

  function openUserFlyout(anchor) {
    closeFlyout();
    const fly = document.createElement('div');
    fly.id = 'start-flyout';
    const user = state.user || {};
    fly.innerHTML = `
      <button data-act="settings">⚙️ Account settings</button>
      <button data-act="wallpaper">🖼️ Change wallpaper</button>
      ${(user.role === 'admin' || user.role === 'owner') ? '<button data-act="admin">🛠️ Admin console</button>' : ''}
      <div class="cm-sep" style="height:1px;margin:5px 8px;background:var(--stroke)"></div>
      <button data-act="signout">⏻ Sign out</button>`;
    document.body.appendChild(fly);
    const rect = anchor.getBoundingClientRect();
    fly.style.left = `${Math.max(10, Math.min(rect.left - 150, window.innerWidth - 240))}px`;
    fly.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    fly.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      closeFlyout();
      toggleStart(false);
      if (btn.dataset.act === 'settings') openSettings('account');
      if (btn.dataset.act === 'wallpaper') openSettings('wallpapers');
      if (btn.dataset.act === 'admin') window.open('/admin', '_blank');
      if (btn.dataset.act === 'signout') {
        const yes = await confirmDialog({ title: 'Sign out of DexterOS?', message: 'Your open windows will be closed.', confirmLabel: 'Sign out' });
        if (!yes) return;
        try { await api.post('/api/auth/logout', {}); } catch { /* ignore */ }
        store.clear();
        location.href = '/';
      }
    });
    setTimeout(() => {
      document.addEventListener('click', function onDoc(ev) {
        if (!fly.contains(ev.target)) { closeFlyout(); document.removeEventListener('click', onDoc); }
      });
    }, 10);
  }

  /* ================================================================== window manager */

  const surface = () => $('#windows-layer');

  function nextCascade() {
    const area = desktopArea();
    const count = state.windows.size;
    const step = 26;
    const w = Math.max(420, Math.min(area.w - 120, Math.round(area.w * 0.62)));
    const h = Math.max(300, Math.min(area.h - 90, Math.round(area.h * 0.66)));
    const left = Math.min(24 + count * step, Math.max(24, area.w - w - 24));
    const top = Math.min(18 + count * step, Math.max(18, area.h - h - 18));
    // Keys must match setBounds' destructuring, otherwise the window falls back to CSS defaults.
    return { left, top, width: w, height: h };
  }

  function focusWindow(win) {
    for (const [, other] of state.windows) {
      other.focused = false;
      other.el.classList.remove('focused');
    }
    win.focused = true;
    win.el.classList.add('focused');
    state.z += 1;
    win.el.style.zIndex = String(state.z);
    renderTaskbar();
  }

  function setBounds(win, bounds) {
    const { left, top, width, height } = bounds;
    win.el.style.left = `${Math.round(left)}px`;
    win.el.style.top = `${Math.round(top)}px`;
    win.el.style.width = `${Math.round(width)}px`;
    win.el.style.height = `${Math.round(height)}px`;
  }

  function readBounds(win) {
    const r = win.el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function maximize(win) {
    if (win.maximized) return;
    win.prev = readBounds(win);
    win.maximized = true;
    win.el.classList.add('maximized');
    const area = desktopArea();
    setBounds(win, { left: 0, top: 0, width: area.w, height: area.h });
    win.maxBtn.textContent = '❐';
    win.maxBtn.title = 'Restore';
  }

  function restore(win) {
    if (!win.maximized) return;
    win.maximized = false;
    win.el.classList.remove('maximized');
    setBounds(win, win.prev || nextCascade());
    win.maxBtn.textContent = '□';
    win.maxBtn.title = 'Maximize';
  }

  function minimize(win) {
    win.el.classList.add('minimized');
    win.focused = false;
    win.el.classList.remove('focused');
    renderTaskbar();
  }

  function showWindow(win) {
    win.el.classList.remove('minimized');
    focusWindow(win);
  }

  function closeWindow(win) {
    win.el.style.transition = 'opacity .12s ease, transform .12s ease';
    win.el.style.opacity = '0';
    win.el.style.transform = 'scale(.97)';
    setTimeout(() => {
      try { if (win.frame) win.frame.src = 'about:blank'; } catch { /* ignore */ }
      win.el.remove();
    }, 120);
    state.windows.delete(win.app.id);
    renderTaskbar();
  }

  function minimizeAll() {
    for (const [, win] of state.windows) win.el.classList.add('minimized');
    for (const [, win] of state.windows) { win.focused = false; win.el.classList.remove('focused'); }
    renderTaskbar();
    toast('All windows minimised — you are back on the home screen.', { title: 'Home screen', timeout: 2600 });
  }

  /* ---------------------------------------------------------------- dragging */
  function makeDraggable(win) {
    const bar = win.el.querySelector('.win-titlebar');
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.caption-btn')) return;
      focusWindow(win);
      if (win.maximized) {
        // Un-maximize and continue the drag from the cursor position.
        const ratio = e.clientX / window.innerWidth;
        restore(win);
        const b = readBounds(win);
        setBounds(win, { left: e.clientX - b.width * ratio, top: Math.max(0, e.clientY - 19), width: b.width, height: b.height });
      }
      const start = { x: e.clientX, y: e.clientY, bounds: readBounds(win) };
      win.el.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
      let snapZone = null;

      const onMove = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        setBounds(win, { left: start.bounds.left + dx, top: Math.max(0, start.bounds.top + dy), width: start.bounds.width, height: start.bounds.height });
        const area = desktopArea();
        snapZone = null;
        if (ev.clientX <= 4) snapZone = 'left';
        else if (ev.clientX >= area.w - 4) snapZone = 'right';
        else if (ev.clientY <= 2) snapZone = 'max';
        const preview = $('#snap-preview');
        if (!snapZone) { preview.style.display = 'none'; return; }
        const geometry = snapGeometry(snapZone, area);
        preview.style.display = 'block';
        preview.style.left = `${geometry.left}px`;
        preview.style.top = `${geometry.top}px`;
        preview.style.width = `${geometry.width}px`;
        preview.style.height = `${geometry.height}px`;
      };
      const onUp = () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        win.el.classList.remove('dragging');
        $('#snap-preview').style.display = 'none';
        if (snapZone) {
          if (snapZone === 'max') { maximize(win); return; }
          win.el.classList.add('snapping');
          setBounds(win, snapGeometry(snapZone, desktopArea()));
          setTimeout(() => win.el.classList.remove('snapping'), 140);
        } else {
          // Keep at least a sliver of the title bar reachable.
          const area = desktopArea();
          const b = readBounds(win);
          const left = Math.min(Math.max(b.left, -b.width + 120), area.w - 80);
          const top = Math.min(Math.max(b.top, 0), area.h - 40);
          setBounds(win, { left, top, width: b.width, height: b.height });
        }
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });

    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest('.caption-btn')) return;
      win.maximized ? restore(win) : maximize(win);
    });
  }

  function snapGeometry(zone, area) {
    switch (zone) {
      case 'left': return { left: 0, top: 0, width: Math.round(area.w / 2), height: area.h };
      case 'right': return { left: Math.round(area.w / 2), top: 0, width: Math.round(area.w / 2), height: area.h };
      default: return { left: 0, top: 0, width: area.w, height: area.h };
    }
  }

  function makeResizable(win) {
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach((dir) => {
      const handle = document.createElement('div');
      handle.className = `resize-handle rh-${dir}`;
      win.el.appendChild(handle);
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        focusWindow(win);
        if (win.maximized) return;
        const start = { x: e.clientX, y: e.clientY, bounds: readBounds(win) };
        win.el.classList.add('resizing');
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          let { left, top, width, height } = start.bounds;
          const minW = 340; const minH = 220;
          if (dir.includes('e')) width = Math.max(minW, start.bounds.width + dx);
          if (dir.includes('s')) height = Math.max(minH, start.bounds.height + dy);
          if (dir.includes('w')) {
            width = Math.max(minW, start.bounds.width - dx);
            left = start.bounds.left + (start.bounds.width - width);
          }
          if (dir.includes('n')) {
            height = Math.max(minH, start.bounds.height - dy);
            top = start.bounds.top + (start.bounds.height - height);
          }
          setBounds(win, { left, top: Math.max(0, top), width, height });
        };
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          win.el.classList.remove('resizing');
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    });
  }

  /* ================================================================== app launching */

  function shellFor(app) {
    const win = {
      app, el: null, frame: null, maximized: false, minimized: false, focused: false,
      prev: null, mode: null,
    };
    const el = document.createElement('div');
    el.className = 'win no-anim';
    el.dataset.appId = String(app.id);
    el.innerHTML = `
      <div class="win-titlebar">
        <span class="wt-icon">${iconInner(app)}</span>
        <span class="wt-title">${esc(app.name)}</span>
        <span class="wt-host">${esc(app.url.startsWith('dexteros://') ? 'DexterOS app' : hostOf(app.url))}</span>
        <span class="wt-spacer"></span>
        <button class="caption-btn min" title="Minimise" aria-label="Minimise">─</button>
        <button class="caption-btn max" title="Maximise" aria-label="Maximise">□</button>
        <button class="caption-btn close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="win-body"></div>`;
    win.el = el;
    win.maxBtn = el.querySelector('.max');
    surface().appendChild(el);

    const bounds = nextCascade();
    setBounds(win, bounds);
    if (state.openMaximized) maximize(win);
    requestAnimationFrame(() => el.classList.remove('no-anim'));

    el.querySelector('.min').addEventListener('click', (e) => { e.stopPropagation(); minimize(win); });
    win.maxBtn.addEventListener('click', (e) => { e.stopPropagation(); win.maximized ? restore(win) : maximize(win); });
    el.querySelector('.close').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.confirmClose) {
        const yes = await confirmDialog({ title: `Close ${app.name}?`, message: 'The app window will be closed.', confirmLabel: 'Close app', danger: true });
        if (!yes) return;
      }
      closeWindow(win);
    });
    el.addEventListener('pointerdown', () => focusWindow(win), true);
    makeDraggable(win);
    makeResizable(win);
    return win;
  }

  async function openApp(app) {
    toggleStart(false);
    const existing = state.windows.get(app.id);
    if (existing) { showWindow(existing); return existing; }

    const win = shellFor(app);
    state.windows.set(app.id, win);
    focusWindow(win);
    renderTaskbar();

    api.post(`/api/portal/apps/${app.id}/launch`, {}).catch(() => {});
    bumpUsage(app.id);

    const body = win.el.querySelector('.win-body');
    body.innerHTML = `<div class="app-loading"><div><div class="ring"></div>Opening <b>${esc(app.name)}</b>…<br><span class="tiny">${esc(hostOf(app.url))}</span></div></div>`;

    if (app.url.startsWith('dexteros://')) {
      renderNativeApp(win, app.url.replace('dexteros://', ''));
      return win;
    }

    try {
      const decision = await resolveEmbed(app);
      if (decision.mode === 'frame') renderFrame(win, app, decision);
      else renderFallback(win, app, decision.reason, decision.probe);
    } catch (err) {
      renderFallback(win, app, `DexterOS could not verify embedding for this site (${err.message}).`, null);
    }
    return win;
  }

  async function resolveEmbed(app) {
    if (app.embed_mode === 'inline') return { mode: 'frame', forced: true };
    if (app.embed_mode === 'external') {
      return { mode: 'fallback', reason: 'The workspace administrator marked this app as “external”, so DexterOS does not try to embed it.' };
    }
    const probe = await api.get(`/api/portal/embed-check?url=${encodeURIComponent(app.url)}`);
    if (probe.embeddable === 1) return { mode: 'frame', probe };
    if (probe.embeddable === 0) return { mode: 'fallback', reason: probe.reason, probe };
    // Unknown: try the frame and give the user an escape hatch in the status bar.
    return { mode: 'frame', probe, uncertain: true };
  }

  function renderFrame(win, app, decision) {
    const body = win.el.querySelector('.win-body');
    const frame = document.createElement('iframe');
    frame.className = 'app-frame';
    frame.setAttribute('title', app.name);
    // Sandbox keeps hostile pages away from the console's own session:
    // scripts/forms/popups allowed (many apps need them) but no top-level navigation
    // and no access to the parent document.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-modals allow-downloads');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('allow', 'clipboard-write; fullscreen');
    frame.src = app.url;
    win.frame = frame;
    body.innerHTML = '';
    body.appendChild(frame);

    const status = document.createElement('div');
    status.className = `win-status${decision.uncertain ? ' blocked' : ''}`;
    status.innerHTML = `
      <span class="dot"></span>
      <span>${esc(hostOf(app.url))}</span>
      <span class="grow"></span>
      ${decision.uncertain ? '<span class="tiny">Embedding unverified</span>' : ''}
      <button class="btn btn-subtle btn-sm" data-compat>Compatibility</button>
      <button class="btn btn-subtle btn-sm" data-reload>Reload</button>`;
    body.appendChild(status);

    const loading = body.querySelector('.app-loading');
    if (loading) loading.remove();
    status.querySelector('[data-reload]').addEventListener('click', () => {
      body.querySelector('.app-loading')?.remove();
      frame.src = app.url;
    });
    status.querySelector('[data-compat]').addEventListener('click', () => {
      renderFallback(win, app, decision.uncertain
        ? 'Embedding could not be verified for this site. If the frame above stays blank or shows an error, the site is refusing to be framed.'
        : 'You asked for compatibility options for this app.', decision.probe, true);
    });
  }

  function renderFallback(win, app, reason, probe, keepFrame) {
    const body = win.el.querySelector('.win-body');
    const isAdmin = state.user && (state.user.role === 'admin' || state.user.role === 'owner');
    body.innerHTML = `
      <div class="app-fallback">
        <div class="fb-card">
          <div class="fb-icon">🛡️</div>
          <h2>${esc(app.name)} can’t be displayed inside a DexterOS window</h2>
          <p>${esc(reason || 'This site refuses to be embedded in a frame.')}</p>
          <p class="tiny muted">This is a security policy set by the website itself (X-Frame-Options / CSP <code>frame-ancestors</code>),
             not a DexterOS error — no desktop console or launcher can override it.</p>
          <div class="fb-url">${esc(app.url)}</div>
          <div class="fb-actions">
            <button class="btn btn-primary" data-act="popout">Open in a secure pop-out window</button>
            <button class="btn" data-act="retry">Retry embedding</button>
            <button class="btn btn-subtle" data-act="copy">Copy link</button>
          </div>
          <div class="fb-alt">
            <h3 style="font-size:14px">How to get the full experience</h3>
            <ul class="tiny muted" style="padding-left:18px;margin:0">
              <li>Use <strong>Open in a secure pop-out window</strong> — DexterOS opens the site in a minimal window of its own, still driven from this console.</li>
              <li>In this deployment, sites such as <strong>Wikipedia, Excalidraw, Notion and MDN</strong> embed perfectly; GitHub, Figma, YouTube and Google properties refuse framing.</li>
              ${isAdmin ? '<li>Administrators can set this app’s <strong>embed mode</strong> to <em>Inline (force)</em> if you know the site renders in frames for your users.</li>' : '<li>Ask your workspace administrator to review this app’s embed mode.</li>'}
            </ul>
            ${isAdmin ? '<div style="margin-top:14px"><a class="btn btn-sm" href="/admin#apps" target="_blank" rel="noopener">Open app settings in the admin console</a></div>' : ''}
          </div>
        </div>
      </div>`;

    const status = document.createElement('div');
    status.className = 'win-status blocked';
    status.innerHTML = `<span class="dot"></span><span>${esc(hostOf(app.url))}</span><span class="grow"></span>
      <span class="tiny">Embedding blocked by the site</span>
      ${keepFrame ? '<button class="btn btn-subtle btn-sm" data-back>Back to frame</button>' : ''}`;
    body.appendChild(status);
    status.querySelector('[data-back]')?.addEventListener('click', () => openApp(app));

    body.querySelector('[data-act="popout"]').addEventListener('click', () => {
      const w = Math.min(1280, Math.round(window.screen.availWidth * 0.8));
      const h = Math.min(900, Math.round(window.screen.availHeight * 0.85));
      window.open(app.url, `dexteros-${app.id}`, `noopener,noreferrer,width=${w},height=${h}`);
      toast('Opened in a DexterOS pop-out window. This is the only case where a site leaves the console — because it forbids embedding.', { title: app.name, timeout: 6000 });
    });
    body.querySelector('[data-act="retry"]').addEventListener('click', async () => {
      toast('Re-testing embedding…', { title: app.name, timeout: 2000 });
      try {
        const probe2 = await api.get(`/api/portal/embed-check?url=${encodeURIComponent(app.url)}&recheck=1`);
        if (probe2.embeddable === 1) { renderFrame(win, app, { probe: probe2 }); toastOk('This site now embeds — opening it.'); }
        else renderFallback(win, app, probe2.reason, probe2);
      } catch (err) { toastErr(err.message); }
    });
    body.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(app.url);
        toastOk('Link copied to your clipboard.');
      } catch { toastErr('Copying failed — your browser blocked clipboard access.'); }
    });
  }

  function bumpUsage(appId) {
    const app = state.apps.find((a) => a.id === appId);
    if (!app) return;
    app.usage = { count: (app.usage?.count || 0) + 1, last_opened_at: new Date().toISOString() };
    state.recent = [app, ...state.recent.filter((a) => a.id !== appId)].slice(0, 5);
  }

  /* ================================================================== native Settings app */

  const SETTINGS_SECTIONS = [
    { id: 'account', label: 'Account', icon: '👤' },
    { id: 'personalization', label: 'Personalization', icon: '🎨' },
    { id: 'wallpapers', label: 'Wallpaper', icon: '🖼️' },
    { id: 'preferences', label: 'Preferences', icon: '⚙️' },
    { id: 'security', label: 'Security', icon: '🔒' },
    { id: 'about', label: 'About DexterOS', icon: 'ℹ️' },
  ];

  function openSettings(section = 'account') {
    const settingsApp = state.apps.find((a) => a.url === 'dexteros://settings');
    const app = settingsApp || { id: 'settings', name: 'Settings', url: 'dexteros://settings', icon: { type: 'emoji', value: '⚙️', bg: '#1e293b' }, embed_mode: 'system' };
    const existing = state.windows.get(app.id);
    if (existing) { showWindow(existing); renderNativeApp(existing, 'settings', section); return; }
    openApp(app).then((win) => {
      if (win) renderNativeApp(win, 'settings', section);
    });
  }

  function renderNativeApp(win, kind, section = 'account') {
    const body = win.el.querySelector('.win-body');
    if (kind !== 'settings') {
      body.innerHTML = `<div class="app-fallback"><div class="fb-card"><h2>Unknown DexterOS app</h2><p class="muted">${esc(kind)} is not a recognised internal app.</p></div></div>`;
      return;
    }
    body.innerHTML = `<div class="native-app">
      <nav class="settings-nav">
        <div class="sn-user">${avatar(state.user || {}, '')}<span><b>${esc(state.user?.name || '')}</b><span>${esc(state.user?.email || '')}</span></span></div>
        ${SETTINGS_SECTIONS.map((s) => `<button data-section="${s.id}" class="${s.id === section ? 'active' : ''}"><span>${s.icon}</span>${esc(s.label)}</button>`).join('')}
      </nav>
      <div class="settings-body" id="settings-body"></div>
    </div>`;
    body.querySelectorAll('[data-section]').forEach((btn) => btn.addEventListener('click', () => {
      body.querySelectorAll('[data-section]').forEach((b) => b.classList.toggle('active', b === btn));
      drawSection(btn.dataset.section);
    }));
    const drawSection = (id) => {
      const host = body.querySelector('#settings-body');
      host.scrollTop = 0;
      if (id === 'account') host.innerHTML = sectionAccount();
      if (id === 'personalization') host.innerHTML = sectionPersonalization();
      if (id === 'wallpapers') host.innerHTML = sectionWallpapers();
      if (id === 'preferences') host.innerHTML = sectionPreferences();
      if (id === 'security') host.innerHTML = sectionSecurity();
      if (id === 'about') host.innerHTML = sectionAbout();
      wireSection(id, host);
    };
    drawSection(section);
  }

  const EMOJIS = ['🙂', '🚀', '🐙', '🦊', '🐼', '🌟', '🎯', '🧠', '💼', '🎧', '🍀', '⚡'];

  function sectionAccount() {
    const u = state.user || {};
    return `
      <h2>Your account</h2>
      <p class="sub">This information is stored on your DexterOS account and visible to your workspace administrators.</p>
      <div class="settings-card">
        <div class="row" style="gap:18px;flex-wrap:wrap">
          <span id="acct-avatar">${avatar(u, 'xl')}</span>
          <div class="grow" style="min-width:200px">
            <div class="row" style="flex-wrap:wrap;gap:8px">
              <label class="btn btn-sm">Upload photo<input type="file" accept="image/*" data-avatar-file hidden></label>
              <button class="btn btn-sm" data-avatar-emoji>Use an emoji</button>
              <button class="btn btn-sm btn-subtle" data-avatar-letter>Use initials</button>
            </div>
            <p class="tiny muted" style="margin:8px 0 0">PNG, JPG, WEBP or SVG up to 6 MB.</p>
          </div>
        </div>
      </div>
      <div class="settings-card">
        <h3>Profile</h3>
        <form id="profile-form">
          <div class="grid-2">
            <div class="field"><label for="pf-name">Full name</label><input class="input" id="pf-name" value="${esc(u.name || '')}" required></div>
            <div class="field"><label for="pf-title">Job title</label><input class="input" id="pf-title" value="${esc(u.title || '')}" placeholder="e.g. Product Designer"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label for="pf-email">Email</label><input class="input" id="pf-email" type="email" value="${esc(u.email || '')}" required></div>
            <div class="field"><label for="pf-phone">Phone</label><input class="input" id="pf-phone" value="${esc(u.phone || '')}" placeholder="Optional"></div>
          </div>
          <div class="row" style="gap:10px">
            <button class="btn btn-primary" type="submit">Save profile</button>
            <span class="tiny muted">Member since ${esc(fmtDate(u.created_at, false))} · Last sign-in ${esc(timeAgo(u.last_login_at))}</span>
          </div>
        </form>
      </div>`;
  }

  function sectionPersonalization() {
    const s = state.settings || {};
    const accents = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#0d9488', '#059669', '#0891b2', '#4f46e5', '#475569'];
    return `
      <h2>Personalization</h2>
      <p class="sub">Make the desktop yours. Preferences are saved to your account and applied at every sign-in.</p>
      <div class="settings-card">
        <h3>Accent colour</h3>
        <div class="swatch-row">
          ${accents.map((c) => `<button class="swatch ${s.accent === c ? 'selected' : ''}" style="background:${c}" data-accent="${c}" title="${c}"></button>`).join('')}
          <input type="color" id="accent-custom" value="${esc(s.accent || '#2563eb')}" title="Custom accent">
          <span class="tiny muted">Custom</span>
        </div>
      </div>
      <div class="settings-card">
        <h3>Appearance</h3>
        <div class="settings-row">
          <span class="sr-label"><b>Theme</b><span>Dark or light interface</span></span>
          <select class="select" style="width:150px" id="set-theme">
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Taskbar alignment</b><span>Where app buttons sit on the bar</span></span>
          <select class="select" style="width:150px" id="set-align">
            <option value="center" ${s.taskbar_align === 'center' ? 'selected' : ''}>Centre</option>
            <option value="left" ${s.taskbar_align === 'left' ? 'selected' : ''}>Left</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Icon size</b><span>Size of desktop shortcuts</span></span>
          <select class="select" style="width:150px" id="set-icon">
            <option value="small" ${s.icon_size === 'small' ? 'selected' : ''}>Small</option>
            <option value="medium" ${s.icon_size === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="large" ${s.icon_size === 'large' ? 'selected' : ''}>Large</option>
          </select>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Show app names</b><span>Display a label under every shortcut</span></span>
          <label class="switch"><input type="checkbox" id="set-labels" ${s.show_labels ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Reduced transparency</b><span>Turns off the acrylic blur effect</span></span>
          <label class="switch"><input type="checkbox" id="set-transparency" ${s.reduced_transparency ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
        </div>
      </div>`;
  }

  function sectionWallpapers() {
    const current = state.settings?.wallpaper_id || state.wallpaper?.id;
    return `
      <h2>Wallpaper</h2>
      <p class="sub">${state.wallpapers.length} wallpaper${state.wallpapers.length === 1 ? '' : 's'} published by your workspace administrator. Pick one — your choice follows your account.</p>
      ${state.wallpapers.length ? `<div class="wp-grid">
        ${state.wallpapers.map((wp) => `
          <div class="wp-card ${current === wp.id ? 'selected current' : ''}" data-wallpaper="${wp.id}">
            <div class="wp-thumb" style="${wp.kind === 'css' ? `background:${esc(wp.value)}` : `background-image:url('${esc(wp.value)}')`}"></div>
            <div class="wp-meta">
              <b>${esc(wp.name)}</b>
              <span>${esc(wp.description || (wp.kind === 'css' ? 'Gradient' : 'Image'))}</span>
              ${wp.is_default ? '<span class="badge" style="margin-top:6px">Workspace default</span>' : ''}
            </div>
          </div>`).join('')}
      </div>` : `<div class="empty-state"><span class="big">🖼️</span>No wallpapers have been published yet. Your administrator can add them from the admin console.</div>`}
      <div class="settings-card" style="margin-top:16px">
        <div class="settings-row">
          <span class="sr-label"><b>Reset to workspace default</b><span>Use whichever wallpaper your admin marked as default</span></span>
          <button class="btn btn-sm" data-wallpaper-clear>Use default</button>
        </div>
      </div>`;
  }

  function sectionPreferences() {
    const usage = state.apps.slice().sort((a, b) => (b.usage?.count || 0) - (a.usage?.count || 0)).slice(0, 5);
    const launches = state.apps.reduce((sum, a) => sum + (a.usage?.count || 0), 0);
    return `
      <h2>Preferences</h2>
      <p class="sub">Desktop behaviour and a quick look at how you use your workspace.</p>
      <div class="settings-card">
        <h3>Desktop behaviour</h3>
        <div class="settings-row">
          <span class="sr-label"><b>Open apps maximised</b><span>New windows fill the desktop</span></span>
          <label class="switch"><input type="checkbox" id="pref-max" ${state.openMaximized ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Ask before closing an app</b><span>Confirm before a window is closed</span></span>
          <label class="switch"><input type="checkbox" id="pref-close" ${state.confirmClose ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="settings-row">
          <span class="sr-label"><b>Taskbar position</b><span>Buttons shown for every running app</span></span>
          <span class="badge badge-good">Always on</span>
        </div>
      </div>
      <div class="settings-card">
        <h3>Your activity</h3>
        <div class="grid-3">
          <div><div class="tiny muted">App launches</div><div style="font-size:24px;font-weight:700">${launches}</div></div>
          <div><div class="tiny muted">Available apps</div><div style="font-size:24px;font-weight:700">${state.apps.length}</div></div>
          <div><div class="tiny muted">Wallpapers</div><div style="font-size:24px;font-weight:700">${state.wallpapers.length}</div></div>
        </div>
        <div class="stack" style="margin-top:14px">
          ${usage.length ? usage.map((a) => `<div class="row"><span class="appicon" style="width:26px;height:26px;font-size:14px">${iconInner(a)}</span>
            <span class="grow small">${esc(a.name)}</span>
            <span class="tiny muted">${a.usage?.count || 0} launch${(a.usage?.count || 0) === 1 ? '' : 'es'}</span></div>`).join('') : '<p class="tiny muted">You have not opened any app yet.</p>'}
        </div>
      </div>`;
  }

  function sectionSecurity() {
    return `
      <h2>Security</h2>
      <p class="sub">Change your password or remove your account from this workspace.</p>
      <div class="settings-card">
        <h3>Change password</h3>
        <form id="password-form">
          <div class="grid-2">
            <div class="field"><label for="pw-current">Current password</label><input class="input" id="pw-current" type="password" autocomplete="current-password" required></div>
            <div class="field"><label for="pw-new">New password</label><input class="input" id="pw-new" type="password" autocomplete="new-password" required>
              <span class="hint">At least 8 characters with letters and numbers.</span></div>
          </div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </div>
      <div class="settings-card danger-zone">
        <h3>Delete account</h3>
        <p class="small muted">This permanently deletes your DexterOS account, your preferences and your app usage history.
          ${(state.user?.role === 'admin' || state.user?.role === 'owner') ? 'Administrators cannot delete the last remaining admin account.' : ''}</p>
        <button class="btn btn-danger" data-delete-account>Delete my account</button>
      </div>`;
  }

  function sectionAbout() {
    const t = state.tenant || {};
    return `
      <h2>About DexterOS</h2>
      <p class="sub">Desktop console build 2.0 · 25H2</p>
      <div class="settings-card">
        <div class="settings-row"><span class="sr-label"><b>Workspace</b><span>${esc(t.name || '')}</span></span>${t.plan ? `<span class="badge badge-accent">${esc(String(t.plan).toUpperCase())}</span>` : ''}</div>
        ${t.join_code ? `<div class="settings-row"><span class="sr-label"><b>Join code</b><span>Share it with teammates so they can register into this workspace</span></span><code class="badge">${esc(t.join_code)}</code></div>` : ''}
        <div class="settings-row"><span class="sr-label"><b>Your role</b><span>${esc(state.user?.role || 'user')}</span></span>${(state.user?.role === 'admin' || state.user?.role === 'owner') ? '<a class="btn btn-sm" href="/admin" target="_blank" rel="noopener">Open admin console</a>' : ''}</div>
        <div class="settings-row"><span class="sr-label"><b>Apps available</b><span>Published by your administrator</span></span><span class="badge">${state.apps.length}</span></div>
      </div>
      <div class="settings-card">
        <h3>How DexterOS handles external sites</h3>
        <p class="small muted" style="margin:0">Apps open inside this console in sandboxed windows. A few sites
          (for example GitHub, Figma and YouTube) forbid being embedded by any launcher; DexterOS detects that and
          offers a secure pop-out window instead of failing silently.</p>
      </div>`;
  }

  function wireSection(id, host) {
    if (id === 'account') {
      host.querySelector('[data-avatar-file]')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const res = await api.upload('/api/me/avatar', file);
          state.user = res.user;
          refreshIdentity();
          toastOk('Profile photo updated.');
          host.querySelector('#acct-avatar').innerHTML = avatar(state.user, 'xl');
        } catch (err) { toastErr(err.message); }
      });
      host.querySelector('[data-avatar-emoji]')?.addEventListener('click', () => {
        modal({
          title: 'Choose an emoji avatar',
          body: `<div style="display:flex;flex-wrap:wrap;gap:8px">${EMOJIS.map((em) => `<button class="btn" style="font-size:22px;width:52px;height:52px" data-emoji="${em}">${em}</button>`).join('')}</div>`,
          onMount(root, close) {
            root.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', async () => {
              try {
                const res = await api.patch('/api/me', { avatar: { type: 'emoji', value: b.dataset.emoji } });
                state.user = res.user; refreshIdentity(); close(); toastOk('Avatar updated.');
                host.querySelector('#acct-avatar').innerHTML = avatar(state.user, 'xl');
              } catch (err) { toastErr(err.message); }
            }));
          },
        });
      });
      host.querySelector('[data-avatar-letter]')?.addEventListener('click', async () => {
        try {
          const res = await api.patch('/api/me', { avatar: { type: 'letter', value: null } });
          state.user = res.user; refreshIdentity(); toastOk('Avatar reset to initials.');
          host.querySelector('#acct-avatar').innerHTML = avatar(state.user, 'xl');
        } catch (err) { toastErr(err.message); }
      });
      host.querySelector('#profile-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api.patch('/api/me', {
            name: host.querySelector('#pf-name').value,
            title: host.querySelector('#pf-title').value,
            email: host.querySelector('#pf-email').value,
            phone: host.querySelector('#pf-phone').value,
          });
          state.user = res.user;
          refreshIdentity();
          toastOk('Profile saved.');
        } catch (err) { toastErr(err.message); }
      });
    }

    if (id === 'personalization') {
      host.querySelectorAll('[data-accent]').forEach((sw) => sw.addEventListener('click', async () => {
        await savePreferences({ accent: sw.dataset.accent }, { message: `Accent colour applied.` });
        host.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', s === sw));
      }));
      host.querySelector('#accent-custom')?.addEventListener('change', async (e) => {
        await savePreferences({ accent: e.target.value }, { message: 'Accent colour applied.' });
      });
      host.querySelector('#set-theme')?.addEventListener('change', (e) => savePreferences({ theme: e.target.value }, { message: 'Theme updated.' }));
      host.querySelector('#set-align')?.addEventListener('change', (e) => savePreferences({ taskbar_align: e.target.value }, { message: 'Taskbar updated.' }));
      host.querySelector('#set-icon')?.addEventListener('change', (e) => savePreferences({ icon_size: e.target.value }, { message: 'Icon size updated.' }));
      host.querySelector('#set-labels')?.addEventListener('change', (e) => savePreferences({ show_labels: e.target.checked }, { message: e.target.checked ? 'App names shown.' : 'App names hidden.' }));
      host.querySelector('#set-transparency')?.addEventListener('change', (e) => savePreferences({ reduced_transparency: e.target.checked }, { message: e.target.checked ? 'Transparency effects disabled.' : 'Transparency effects enabled.' }));
    }

    if (id === 'wallpapers') {
      host.querySelectorAll('[data-wallpaper]').forEach((card) => card.addEventListener('click', async () => {
        const wpId = Number(card.dataset.wallpaper);
        try {
          const res = await api.patch('/api/me/preferences', { wallpaper_id: wpId });
          applySettings(res.settings);
          applyWallpaper(state.wallpapers.find((w) => w.id === wpId) || null);
          host.querySelectorAll('.wp-card').forEach((c) => c.classList.toggle('selected', c === card));
          toastOk('Wallpaper applied and saved to your account.');
        } catch (err) { toastErr(err.message); }
      }));
      host.querySelector('[data-wallpaper-clear]')?.addEventListener('click', async () => {
        try {
          const res = await api.patch('/api/me/preferences', { wallpaper_id: null });
          applySettings(res.settings);
          const def = state.wallpapers.find((w) => w.is_default) || state.wallpapers[0] || null;
          applyWallpaper(def);
          toastOk('Using the workspace default wallpaper.');
        } catch (err) { toastErr(err.message); }
      });
    }

    if (id === 'preferences') {
      host.querySelector('#pref-max')?.addEventListener('change', (e) => {
        state.openMaximized = e.target.checked;
        localStorage.setItem('dexteros.openMaximized', e.target.checked ? '1' : '0');
        toastOk(e.target.checked ? 'New apps will open maximised.' : 'New apps will open in a window.');
      });
      host.querySelector('#pref-close')?.addEventListener('change', (e) => {
        state.confirmClose = e.target.checked;
        localStorage.setItem('dexteros.confirmClose', e.target.checked ? '1' : '0');
        toastOk(e.target.checked ? 'DexterOS will confirm before closing apps.' : 'Apps will close straight away.');
      });
    }

    if (id === 'security') {
      host.querySelector('#password-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api.patch('/api/me/password', {
            current_password: host.querySelector('#pw-current').value,
            new_password: host.querySelector('#pw-new').value,
          });
          toastOk('Password updated.');
          host.querySelector('#pw-current').value = '';
          host.querySelector('#pw-new').value = '';
        } catch (err) { toastErr(err.message); }
      });
      host.querySelector('[data-delete-account]')?.addEventListener('click', () => {
        modal({
          title: 'Delete your DexterOS account',
          body: `<p class="small">This cannot be undone. Type your password to confirm.</p>
                 <div class="field"><label for="del-pw">Password</label><input class="input" id="del-pw" type="password" autocomplete="current-password"></div>
                 <label class="check"><input type="checkbox" id="del-ack"> <span class="small">I understand my data, preferences and usage history will be deleted.</span></label>`,
          footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-confirm>Delete account</button>',
          onMount(root, close) {
            root.querySelector('[data-confirm]').addEventListener('click', async () => {
              const pw = root.querySelector('#del-pw').value;
              if (!root.querySelector('#del-ack').checked) return toastErr('Please confirm you understand what will be deleted.');
              try {
                await api.del('/api/me', { password: pw });
                store.clear();
                toastOk('Your account has been deleted.');
                setTimeout(() => { location.href = '/'; }, 900);
              } catch (err) { toastErr(err.message); }
            });
          },
        });
      });
    }
  }

  function refreshIdentity() {
    renderStart($('#start-search').value || '');
    renderTaskbar();
  }

  /* ================================================================== context menu */

  function closeContext() {
    $('#context-menu')?.remove();
  }

  function showContextMenu(x, y, items, title) {
    closeContext();
    const menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.innerHTML = `${title ? `<div class="cm-title">${esc(title)}</div>` : ''}
      ${items.map((item, i) => item === '-' ? '<div class="cm-sep"></div>' : `<button data-i="${i}">${item.icon ? `${item.icon} ` : ''}${esc(item.label)}</button>`).join('')}`;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-i]');
      if (!btn) return;
      const item = items[Number(btn.dataset.i)];
      closeContext();
      item.action?.();
    });
    setTimeout(() => {
      document.addEventListener('pointerdown', function onDoc(ev) {
        if (!menu.contains(ev.target)) { closeContext(); document.removeEventListener('pointerdown', onDoc); }
      });
    }, 10);
  }

  function desktopContextMenu(e) {
    const s = state.settings || {};
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Show the home screen', icon: '🏠', action: minimizeAll },
      { label: 'Refresh app list', icon: '🔄', action: () => refreshApps({ manual: true }) },
      '-',
      { label: 'Icon size: small', icon: s.icon_size === 'small' ? '●' : '○', action: () => savePreferences({ icon_size: 'small' }, { message: 'Icon size: small' }) },
      { label: 'Icon size: medium', icon: s.icon_size === 'medium' ? '●' : '○', action: () => savePreferences({ icon_size: 'medium' }, { message: 'Icon size: medium' }) },
      { label: 'Icon size: large', icon: s.icon_size === 'large' ? '●' : '○', action: () => savePreferences({ icon_size: 'large' }, { message: 'Icon size: large' }) },
      { label: s.show_labels ? 'Hide app names' : 'Show app names', icon: '🏷️', action: () => savePreferences({ show_labels: !s.show_labels }) },
      '-',
      { label: 'Sort shortcuts by name', icon: '🔤', action: () => sortApps('name') },
      { label: 'Sort shortcuts by category', icon: '🗂️', action: () => sortApps('category') },
      { label: 'Sort by most used', icon: '🔥', action: () => sortApps('usage') },
      '-',
      { label: 'Personalize', icon: '🎨', action: () => openSettings('personalization') },
      { label: 'Change wallpaper', icon: '🖼️', action: () => openSettings('wallpapers') },
      '-',
      { label: 'Settings', icon: '⚙️', action: () => openSettings('account') },
      ...(state.user && (state.user.role === 'admin' || state.user.role === 'owner')
        ? ['-', { label: 'Open admin console', icon: '🛠️', action: () => window.open('/admin', '_blank') }] : []),
    ], `DexterOS · ${state.tenant?.name || ''}`);
  }

  function sortApps(by) {
    state.appSort = by;
    if (by === 'name') state.apps.sort((a, b) => a.name.localeCompare(b.name));
    if (by === 'category') state.apps.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
    if (by === 'usage') state.apps.sort((a, b) => (b.usage?.count || 0) - (a.usage?.count || 0) || a.name.localeCompare(b.name));
    renderGrid();
    renderStart($('#start-search').value || '');
    toast(`Shortcuts sorted by ${by === 'usage' ? 'most used' : by}.`, { title: 'Desktop', timeout: 2400 });
  }

  function tileContextMenu(e, app) {
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: '▶️', action: () => openApp(app) },
      { label: 'Open in a second window', icon: '🪟', action: () => openApp(app) },
      '-',
      { label: 'Copy link', icon: '🔗', action: async () => {
        try { await navigator.clipboard.writeText(app.url); toastOk('Link copied.'); } catch { toastErr('Copy blocked by the browser.'); }
      } },
      '-',
      { label: 'More details', icon: 'ℹ️', action: () => showAppDetails(app) },
    ], app.name);
  }

  function showAppDetails(app) {
    modal({
      title: app.name,
      body: `<div class="row" style="gap:14px;align-items:flex-start">
          <span class="appicon" style="width:56px;height:56px;font-size:28px">${iconInner(app)}</span>
          <div class="grow">
            <p class="small" style="margin:0 0 6px">${esc(app.description || 'No description provided by your administrator.')}</p>
            <div class="tiny muted">${esc(app.url)}</div>
          </div>
        </div>
        <div class="stack" style="margin-top:16px">
          <div class="row-between small"><span class="muted">Category</span><span>${esc(app.category || 'General')}</span></div>
          <div class="row-between small"><span class="muted">Embed mode</span><span>${esc(app.embed_mode)}</span></div>
          <div class="row-between small"><span class="muted">Launches</span><span>${app.usage?.count || 0} by you · ${app.open_count} total</span></div>
          <div class="row-between small"><span class="muted">Added</span><span>${esc(fmtDate(app.created_at, false))}</span></div>
        </div>`,
      footer: '<button class="btn" data-close>Close</button><button class="btn btn-primary" data-open>Open app</button>',
      onMount(root, close) {
        root.querySelector('[data-open]').addEventListener('click', () => { close(); openApp(app); });
      },
    });
  }

  /* ================================================================== polling / refresh */

  async function refreshApps({ manual = false } = {}) {
    try {
      const res = await api.get('/api/portal/apps');
      const signature = JSON.stringify(res.apps.map((a) => [a.id, a.name, a.url, a.icon.value, a.is_visible, a.is_enabled, a.is_pinned]));
      if (signature !== state.appsSignature) {
        const first = !state.appsSignature;
        const previous = new Set(state.apps.map((a) => a.id));
        state.appsSignature = signature;
        state.apps = res.apps;
        renderGrid();
        renderTaskbar();
        renderStart($('#start-search')?.value || '');
        if (!first && !manual) {
          const added = res.apps.filter((a) => !previous.has(a.id));
          toast(added.length ? `${added.length} new app${added.length === 1 ? '' : 's'} now available: ${added.map((a) => a.name).join(', ')}`
            : 'Your workspace apps were updated by an administrator.', { title: 'Workspace updated', timeout: 5200 });
        }
        if (manual) toastOk('App list refreshed.');
      } else if (manual) {
        toast('Everything is up to date.', { title: 'App list', timeout: 2200 });
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        // The session expired or the account was suspended while the desktop was open.
        toast(err.message || 'Your session has ended. Returning to the sign-in page…', { title: 'Session ended', type: 'error', timeout: 6000 });
        store.clear();
        setTimeout(() => { location.href = '/'; }, 1400);
        return;
      }
      if (manual) toastErr(err.message);
    }
  }

  /* ================================================================== boot */

  function wireShell() {
    $('#start-button').addEventListener('click', () => toggleStart());
    $('#tb-user').addEventListener('click', (e) => { e.stopPropagation(); openUserFlyout(e.currentTarget); });
    $('#show-home').addEventListener('click', minimizeAll);
    $('#show-desktop').addEventListener('click', minimizeAll);

    $('#desktop').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-settings]')) { openSettings('account'); return; }
      const tile = e.target.closest('.tile');
      if (!tile) { $$('.tile').forEach((t) => t.classList.remove('selected')); return; }
      $$('.tile').forEach((t) => t.classList.remove('selected'));
      tile.classList.add('selected');
      const app = state.apps.find((a) => a.id === Number(tile.dataset.app));
      if (app) openApp(app);
    });
    $('#desktop').addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.tile');
      e.preventDefault();
      if (tile) {
        const app = state.apps.find((a) => a.id === Number(tile.dataset.app));
        if (app) return tileContextMenu(e, app);
      }
      return desktopContextMenu(e);
    });

    $('#taskbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tb-app]');
      if (!btn) return;
      const id = Number(btn.dataset.tbApp);
      const app = state.apps.find((a) => a.id === id) || (state.windows.get(id) || {}).app;
      if (!app) return;
      const win = state.windows.get(id);
      if (!win) return openApp(app);
      if (win.el.classList.contains('minimized')) return showWindow(win);
      if (win.focused) return minimize(win);
      return showWindow(win);
    });
    $('#taskbar').addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('[data-tb-app]');
      e.preventDefault();
      if (!btn) {
        return showContextMenu(e.clientX, e.clientY, [
          { label: 'Show the home screen', icon: '🏠', action: minimizeAll },
          { label: 'Taskbar settings', icon: '⚙️', action: () => openSettings('personalization') },
          '-',
          { label: 'Close all windows', icon: '✕', action: () => { for (const [, w] of Array.from(state.windows)) closeWindow(w); } },
        ], 'Taskbar');
      }
      const id = Number(btn.dataset.tbApp);
      const app = state.apps.find((a) => a.id === id) || state.windows.get(id)?.app;
      const win = state.windows.get(id);
      return showContextMenu(e.clientX, e.clientY, [
        { label: 'Open a new window', icon: '🪟', action: () => openApp(app) },
        ...(win ? [
          { label: 'Minimise', icon: '─', action: () => minimize(win) },
          { label: win.maximized ? 'Restore' : 'Maximise', icon: '□', action: () => (win.maximized ? restore(win) : maximize(win)) },
          '-',
          { label: 'Close window', icon: '✕', action: () => closeWindow(win) },
        ] : []),
      ], app?.name);
    });

    $('#start-menu').addEventListener('click', (e) => {
      const appBtn = e.target.closest('[data-app]');
      if (appBtn) {
        const app = state.apps.find((a) => a.id === Number(appBtn.dataset.app));
        if (app) openApp(app);
        return;
      }
      if (e.target.closest('#start-settings')) { toggleStart(false); openSettings('account'); }
      if (e.target.closest('#start-home')) { toggleStart(false); minimizeAll(); }
      if (e.target.closest('#start-admin-link')) { window.open('/admin', '_blank'); }
      if (e.target.closest('#start-user')) { openUserFlyout(e.target.closest('#start-user')); }
    });
    $('#start-search').addEventListener('input', (e) => renderStart(e.target.value));
    $('#start-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('#start-grid [data-app]') || $('#start-list [data-app]');
        if (first) first.click();
      }
    });

    document.addEventListener('pointerdown', (e) => {
      const menu = $('#start-menu');
      if (menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('#start-button') && !e.target.closest('#start-flyout')) toggleStart(false);
    });

    window.addEventListener('resize', () => {
      const area = desktopArea();
      for (const [, win] of state.windows) {
        if (win.maximized) { setBounds(win, { left: 0, top: 0, width: area.w, height: area.h }); continue; }
        const b = readBounds(win);
        setBounds(win, {
          left: Math.min(b.left, Math.max(0, area.w - 120)),
          top: Math.min(b.top, Math.max(0, area.h - 60)),
          width: Math.min(b.width, area.w), height: Math.min(b.height, area.h),
        });
      }
      renderStart($('#start-search').value || '');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { toggleStart(false); closeContext(); }
      if (e.altKey && e.key === 'Home') { e.preventDefault(); minimizeAll(); }
      if (e.altKey && e.key === 'Tab') {
        e.preventDefault();
        const wins = Array.from(state.windows.values());
        if (wins.length < 2) return;
        const focusedIndex = wins.findIndex((w) => w.focused);
        const next = wins[(focusedIndex + 1) % wins.length];
        showWindow(next);
      }
      if (e.altKey && e.key === 'F4') {
        const win = Array.from(state.windows.values()).find((w) => w.focused);
        if (win) { e.preventDefault(); closeWindow(win); }
      }
      if (e.key === 'F5' && e.ctrlKey) { e.preventDefault(); refreshApps({ manual: true }); }
    });

    // Live clock.
    setInterval(() => {
      const now = new Date();
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      $('#tb-clock').innerHTML = `<b>${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</b><br>${days[now.getDay()]} ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
    }, 20000);

    // Keep the console in sync with administrator changes.
    setInterval(() => refreshApps(), 45000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshApps(); });
  }

  async function boot() {
    try {
      const data = await api.get('/api/portal/bootstrap');
      state.user = data.user;
      state.tenant = data.tenant;
      state.settings = data.settings;
      state.wallpapers = data.wallpapers;
      state.recent = data.recent || [];
      state.recommended = data.recommended || [];
      state.apps = data.apps || [];
      state.appsSignature = JSON.stringify(state.apps.map((a) => [a.id, a.name, a.url, a.icon.value, a.is_visible, a.is_enabled, a.is_pinned]));

      applySettings(data.settings);
      applyWallpaper(data.wallpaper);
      renderGrid();
      renderTaskbar();
      renderStart('');
      wireShell();
      $('#splash').classList.add('gone');

      const params = new URLSearchParams(location.search);
      if (params.get('admin') === '1' && (state.user.role === 'admin' || state.user.role === 'owner')) {
        window.open('/admin', '_blank');
        history.replaceState(null, '', '/app');
      }
      if (!localStorage.getItem('dexteros.hintShown')) {
        localStorage.setItem('dexteros.hintShown', '1');
        setTimeout(() => toast('Click an app icon to open it inside DexterOS. Right-click the desktop for more options.', {
          title: `Welcome, ${state.user.name.split(' ')[0]}`, timeout: 7000,
        }), 500);
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        store.clear();
        location.href = '/';
        return;
      }
      $('#splash').innerHTML = `<div class="splash-inner">
        <div class="splash-mark">D</div>
        <h1>DexterOS could not start</h1>
        <p>${esc(err.message)}</p>
        <button class="btn btn-primary" id="retry">Try again</button></div>`;
      $('#retry').addEventListener('click', () => location.reload());
    }
  }

  boot();
}());
