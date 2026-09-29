/* ==========================================================================
   DexterOS — admin console
   Applications, wallpapers, members, activity and workspace settings.
   ========================================================================== */
(function () {
  'use strict';

  const { api, esc, appIcon, avatar, toast, toastOk, toastErr, modal, confirmDialog, fmtDate, timeAgo, humanAction, hostOf, store } = window.DX;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    session: null,
    apps: [],
    wallpapers: [],
    users: [],
    summary: null,
    overview: null,
    view: 'overview',
    filters: { appQuery: '', appStatus: 'all', userQuery: '', userStatus: 'all', userRole: 'all' },
  };

  const EMOJIS = ('📚 📝 ✏️ 🎨 📊 📈 🗺️ ▶️ 🎧 🎬 🐙 💬 📅 📁 🔐 🧪 🧮 🛠️ ⚙️ ☁️ 🌐 📷 🔎 🏢 💼 🧭 🧾 📦 🚀 🧠 ⏱️ 📌 🗂️ 🧰 🔔 🎟️ 🏷️ 💡 🔗 ✅ 🧲 🪄 📡 🖥️ 🖨️ 🧑‍💻 🛡️ 🧳 🌍 🕹️ 🎯 🥇 🍀 ⚡ 🔋 🌈 🧩 🪄 💾 ☑️').split(' ');
  const SWATCHES = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#0d9488', '#059669', '#0891b2', '#4f46e5', '#1e293b', '#0f172a', '#475569'];

  /* ================================================================== chrome */

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    localStorage.setItem('dexteros.admin.theme', theme);
  }
  setTheme(localStorage.getItem('dexteros.admin.theme') || 'dark');
  $('#theme-toggle').addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  const VIEWS = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'apps', label: 'Applications', icon: '🧩' },
    { id: 'wallpapers', label: 'Wallpapers', icon: '🖼️' },
    { id: 'users', label: 'Members', icon: '👥' },
    { id: 'activity', label: 'Activity', icon: '🕓' },
    { id: 'workspace', label: 'Workspace', icon: '🏢' },
  ];

  function renderSide() {
    $('#side-nav').innerHTML = VIEWS.map((v) => `
      <button data-view="${v.id}" class="${state.view === v.id ? 'active' : ''}">
        <span>${v.icon}</span>${esc(v.label)}
        <span class="pill">${v.id === 'apps' ? state.apps.length : v.id === 'wallpapers' ? state.wallpapers.length : v.id === 'users' ? (state.summary?.total ?? '') : ''}</span>
      </button>`).join('');
    const u = state.session.user;
    $('#side-user').innerHTML = `${avatar(u, '')}<span><b>${esc(u.name)}</b><span>${esc(u.role === 'owner' ? 'Workspace owner' : 'Administrator')}</span></span>`;
    $('#side-workspace').textContent = state.session.tenant.name;
  }

  /**
   * A view render must start from a listener-free container, otherwise repeated
   * renders stack duplicate click/change handlers (which opened duplicate modals).
   */
  function freshView() {
    const current = document.getElementById('view');
    const fresh = current.cloneNode(false);
    fresh.innerHTML = '';
    current.replaceWith(fresh);
    return fresh;
  }

  async function go(view) {
    state.view = view;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    renderSide();
    $('#view').innerHTML = `<div class="stack"><div class="skeleton" style="height:24px;width:220px"></div><div class="skeleton" style="height:180px"></div></div>`;
    try {
      if (view === 'overview') await viewOverview();
      if (view === 'apps') await viewApps();
      if (view === 'wallpapers') await viewWallpapers();
      if (view === 'users') await viewUsers();
      if (view === 'activity') await viewActivity();
      if (view === 'workspace') await viewWorkspace();
    } catch (err) {
      $('#view').innerHTML = `<div class="empty-state"><span class="big">⚠️</span>${esc(err.message)}</div>`;
    }
  }

  /* ================================================================== overview */

  async function viewOverview() {
    const view = freshView();
    const data = await api.get('/api/admin/overview');
    state.overview = data;
    const s = data.stats;
    const maxUsage = Math.max(1, ...data.usageByApp.map((u) => u.launches));
    // Always chart a full 14-day window so a single signup day still reads as a trend.
    const byDay = new Map(data.signups.map((d) => [d.day, d.n]));
    const signups = Array.from({ length: 14 }, (_, i) => {
      const day = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10);
      return { day, n: byDay.get(day) || 0 };
    });
    const maxSignup = Math.max(1, ...signups.map((d) => d.n));
    const w = 520;
    const barW = Math.min(56, w / signups.length);
    const offsetX = (w - barW * signups.length) / 2;

    view.innerHTML = `
      <div class="view-head">
        <div>
          <h2>Workspace overview</h2>
          <p>Live picture of ${esc(data.workspace.name)} — updated ${esc(timeAgo(new Date().toISOString()))}.</p>
        </div>
        <div class="row">
          <button class="btn" data-act="refresh">🔄 Refresh</button>
          <button class="btn btn-primary" data-act="new-app">＋ Add application</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat"><div class="label">Members</div><div class="value">${s.users}</div>
          <div class="delta">${s.activeUsers} active · ${s.disabledUsers} suspended · +${s.newUsers7d} this week</div></div>
        <div class="stat"><div class="label">Applications</div><div class="value">${s.apps}</div>
          <div class="delta">${s.enabledApps} visible to members · ${s.hiddenApps} hidden or disabled</div></div>
        <div class="stat"><div class="label">App launches</div><div class="value">${s.launches}</div>
          <div class="delta">across all members</div></div>
        <div class="stat"><div class="label">Wallpapers</div><div class="value">${s.wallpapers}</div>
          <div class="delta">${s.enabledWallpapers} available to members</div></div>
      </div>

      <div class="grid-split">
        <div class="card" style="padding:18px 20px">
          <div class="row-between" style="margin-bottom:10px"><strong>Most used applications</strong>
            <span class="badge">${s.sessionsNow} live session${s.sessionsNow === 1 ? '' : 's'}</span></div>
          ${data.usageByApp.map((u) => `
            <div class="bar-row">
              <span class="name truncate" title="${esc(u.name)}">${esc(u.name)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, Math.round((u.launches / maxUsage) * 100))}%"></span></span>
              <span class="num">${u.launches}</span>
            </div>`).join('')}
          <div style="margin-top:18px"><strong>New members (last 14 days)</strong>
            <svg class="spark" viewBox="0 0 ${w} 92" preserveAspectRatio="none" role="img" aria-label="Signups chart">
              ${signups.map((d, i) => {
                const h = Math.max(d.n ? 6 : 2, Math.round((d.n / maxSignup) * 74));
                return `<rect x="${(offsetX + i * barW + barW * 0.16).toFixed(1)}" y="${88 - h}" width="${(barW * 0.68).toFixed(1)}" height="${h}" rx="2"><title>${esc(d.day)}: ${d.n} new member${d.n === 1 ? '' : 's'}</title></rect>`;
              }).join('')}
              <line x1="0" y1="89" x2="${w}" y2="89" stroke="currentColor" stroke-opacity="0.15" />
            </svg>
          </div>
        </div>

        <div class="card" style="padding:18px 20px">
          <div class="row-between" style="margin-bottom:6px"><strong>Recent activity</strong>
            <button class="btn btn-subtle btn-sm" data-act="all-activity">View all</button></div>
          <div class="activity">
            ${data.activity.map((a) => `
              <div class="item">
                <span class="ico">${activityIcon(a.action)}</span>
                <span><b>${esc(humanAction(a.action))}</b><span>${esc(a.detail || '')}${a.actor ? ` · ${esc(a.actor)}` : ''}</span></span>
                <time>${esc(timeAgo(a.created_at))}</time>
              </div>`).join('') || '<p class="muted small">No activity recorded yet.</p>'}
          </div>
        </div>
      </div>`;

    view.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="refresh"]')) go('overview');
      if (e.target.closest('[data-act="new-app"]')) appModal();
      if (e.target.closest('[data-act="all-activity"]')) go('activity');
    }, { once: true });
  }

  function activityIcon(action) {
    if (String(action).startsWith('app')) return '🧩';
    if (String(action).startsWith('wallpaper')) return '🖼️';
    if (String(action).startsWith('user')) return '👤';
    if (String(action).startsWith('workspace')) return '🏢';
    return '•';
  }

  /* ================================================================== applications */

  async function loadApps() {
    const res = await api.get('/api/admin/apps');
    state.apps = res.apps;
    return res.apps;
  }

  async function viewApps() {
    await loadApps();
    renderApps();
  }

  function filteredApps() {
    const q = state.filters.appQuery.toLowerCase();
    return state.apps.filter((a) => {
      if (q && !(`${a.name} ${a.url} ${a.category} ${a.description}`.toLowerCase().includes(q))) return false;
      if (state.filters.appStatus === 'visible' && !(a.is_enabled && a.is_visible)) return false;
      if (state.filters.appStatus === 'hidden' && !(a.is_enabled && !a.is_visible)) return false;
      if (state.filters.appStatus === 'disabled' && a.is_enabled) return false;
      if (state.filters.appStatus === 'pinned' && !a.is_pinned) return false;
      return true;
    });
  }

  function renderApps() {
    const view = freshView();
    const rows = filteredApps();
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h2>Applications</h2>
          <p>Everything here appears on your members' desktop instantly — no front-end changes needed.</p>
        </div>
        <button class="btn btn-primary" data-act="new-app">＋ Add application</button>
      </div>

      <div class="toolbar">
        <input class="input" id="app-q" placeholder="Search apps, URLs or categories…" value="${esc(state.filters.appQuery)}">
        <select class="select" id="app-status">
          <option value="all" ${state.filters.appStatus === 'all' ? 'selected' : ''}>All apps (${state.apps.length})</option>
          <option value="visible" ${state.filters.appStatus === 'visible' ? 'selected' : ''}>Visible to members</option>
          <option value="hidden" ${state.filters.appStatus === 'hidden' ? 'selected' : ''}>Hidden</option>
          <option value="disabled" ${state.filters.appStatus === 'disabled' ? 'selected' : ''}>Disabled</option>
          <option value="pinned" ${state.filters.appStatus === 'pinned' ? 'selected' : ''}>Pinned to taskbar</option>
        </select>
        <span class="spacer"></span>
        <span class="tiny muted">${rows.length} of ${state.apps.length} shown</span>
      </div>

      <div class="card" style="overflow:hidden">
        <table class="table">
          <thead><tr>
            <th style="width:32%">Application</th><th>Category</th>
            <th>Members see<div class="sub" style="text-transform:none">enabled / visible</div></th>
            <th>Pinned</th><th>Launches</th><th style="width:210px;text-align:right">Actions</th>
          </tr></thead>
          <tbody>
            ${rows.map((a) => `
              <tr data-app-row="${a.id}">
                <td>
                  <div class="app-cell">
                    ${appIcon(a, 40)}
                    <span class="meta">
                      <b>${esc(a.name)} ${a.is_system ? '<span class="badge badge-accent">System</span>' : ''}</b>
                      <span>${esc(hostOf(a.url))} · embed: ${esc(a.embed_mode)}</span>
                    </span>
                  </div>
                </td>
                <td class="small">${esc(a.category)}</td>
                <td>
                  ${a.is_system ? '<span class="badge badge-accent">Always on</span>'
                    : `<label class="switch" title="Enable or disable this app for everyone"><input type="checkbox" data-toggle="enabled" data-id="${a.id}" ${a.is_enabled ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
                       <label class="switch" style="margin-left:8px" title="Control visibility on the desktop"><input type="checkbox" data-toggle="visible" data-id="${a.id}" ${a.is_visible ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>`}
                </td>
                <td>
                  <label class="switch"><input type="checkbox" data-toggle="pinned" data-id="${a.id}" ${a.is_pinned ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
                </td>
                <td class="small">${a.open_count}</td>
                <td>
                  <div class="actions">
                    <button class="btn btn-sm" data-act="edit" data-id="${a.id}">Edit</button>
                    <button class="btn btn-sm btn-subtle" data-act="preview" data-id="${a.id}" title="Preview">👁</button>
                    ${a.is_system ? '' : `<button class="btn btn-sm btn-subtle" data-act="delete" data-id="${a.id}" title="Delete">🗑</button>`}
                  </div>
                </td>
              </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state"><span class="big">🧩</span>No applications match this filter.</div></td></tr>'}
          </tbody>
        </table>
      </div>

      <p class="tiny muted" style="margin-top:12px">Required when creating an app: <strong>App name</strong>, <strong>App link</strong> and <strong>App icon</strong>.
        The Settings app is a protected system app — it can never be disabled or deleted.</p>`;

    $('#app-q').addEventListener('input', (e) => {
      state.filters.appQuery = e.target.value;
      const caret = e.target.selectionStart;
      renderApps();
      const next = $('#app-q');
      next.focus();
      next.setSelectionRange(caret, caret);
    });
    $('#app-status').addEventListener('change', (e) => { state.filters.appStatus = e.target.value; renderApps(); });

    view.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = Number(act.dataset.id);
      const app = state.apps.find((a) => a.id === id);
      if (act.dataset.act === 'new-app') return appModal();
      if (act.dataset.act === 'edit') return appModal(app);
      if (act.dataset.act === 'preview') return previewApp(app);
      if (act.dataset.act === 'delete') {
        const yes = await confirmDialog({
          title: `Delete “${app.name}”?`,
          message: 'The shortcut disappears from every member\'s desktop immediately. Usage history for this app is removed too.',
          confirmLabel: 'Delete application', danger: true,
        });
        if (!yes) return;
        try {
          await api.del(`/api/admin/apps/${id}`);
          toastOk(`“${app.name}” deleted.`);
          await viewApps();
        } catch (err) { toastErr(err.message); }
      }
    });

    view.addEventListener('change', async (e) => {
      const input = e.target.closest('[data-toggle]');
      if (!input) return;
      const id = Number(input.dataset.id);
      const field = input.dataset.toggle;
      const key = field === 'enabled' ? 'is_enabled' : field === 'visible' ? 'is_visible' : 'is_pinned';
      try {
        const res = await api.patch(`/api/admin/apps/${id}`, { [key]: input.checked });
        const i = state.apps.findIndex((a) => a.id === id);
        state.apps[i] = res.app;
        toastOk(`${res.app.name}: ${field} ${input.checked ? 'on' : 'off'}. Changes are live for members.`);
        renderSide();
      } catch (err) {
        input.checked = !input.checked;
        toastErr(err.message);
      }
    });
  }

  function previewApp(app) {
    modal({
      title: `${app.name} — live preview`,
      wide: true,
      body: `<div class="row" style="margin-bottom:10px">
          ${appIcon(app, 40)}
          <div class="grow"><b>${esc(app.name)}</b><div class="tiny muted">${esc(app.url)}</div></div>
          <span class="badge ${app.is_enabled && app.is_visible ? 'badge-good' : 'badge-warn'}">${app.is_enabled && app.is_visible ? 'Visible to members' : 'Hidden from members'}</span>
        </div>
        <div style="border:1px solid var(--stroke);border-radius:10px;overflow:hidden;background:#fff;height:60vh">
          <iframe src="${esc(app.url)}" style="width:100%;height:100%;border:0" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
        <p class="tiny muted" style="margin-top:10px">If the frame stays blank, the site refuses to be embedded (X-Frame-Options / CSP). Members see
          DexterOS's compatibility panel in that case.</p>`,
      footer: '<button class="btn" data-close>Close</button>',
    });
  }

  function appModal(app) {
    const isEdit = !!app;
    const current = app || { name: '', url: '', category: 'General', description: '', icon_type: 'emoji', icon_value: '🚀', icon_bg: '#2563eb', embed_mode: 'auto', sort_order: 100, is_enabled: true, is_visible: true, is_pinned: false };
    const icon = { type: current.icon_type, value: current.icon_value, bg: current.icon_bg };

    modal({
      title: isEdit ? `Edit “${current.name}”` : 'Add a new application',
      wide: true,
      body: `
        <div class="grid-2">
          <div>
            <div class="field"><label for="f-name">App name <span style="color:var(--danger)">*</span></label>
              <input class="input" id="f-name" value="${esc(current.name)}" placeholder="e.g. Notion" required></div>
            <div class="field"><label for="f-url">App link <span style="color:var(--danger)">*</span></label>
              <input class="input" id="f-url" value="${esc(current.url)}" placeholder="https://example.com" required ${current.is_system ? 'disabled' : ''}>
              <span class="hint">Only http(s) links are accepted. Members open this inside the console.</span></div>
            <div class="grid-2">
              <div class="field"><label for="f-cat">Category</label><input class="input" id="f-cat" value="${esc(current.category)}" placeholder="Productivity"></div>
              <div class="field"><label for="f-sort">Sort order</label><input class="input" id="f-sort" type="number" min="0" max="9999" value="${Number(current.sort_order) || 0}"></div>
            </div>
            <div class="field"><label for="f-desc">Description</label>
              <textarea class="textarea" id="f-desc" placeholder="Shown in app details and search">${esc(current.description)}</textarea></div>
            <div class="field"><label for="f-embed">Embed mode</label>
              <select class="select" id="f-embed" ${current.is_system ? 'disabled' : ''}>
                <option value="auto" ${current.embed_mode === 'auto' ? 'selected' : ''}>Auto — DexterOS tests embedding (recommended)</option>
                <option value="inline" ${current.embed_mode === 'inline' ? 'selected' : ''}>Inline (force) — always open inside a window</option>
                <option value="external" ${current.embed_mode === 'external' ? 'selected' : ''}>External — skip embedding, use the compatibility panel</option>
              </select>
              <span class="hint">Sites such as GitHub, Figma and YouTube block framing; "Auto" handles them gracefully.</span></div>
          </div>
          <div>
            <div class="field"><label>App icon <span style="color:var(--danger)">*</span></label>
              <div class="icon-preview">
                <span class="big-tile" id="icon-preview"></span>
                <div class="grow">
                  <div class="tabs" style="margin-bottom:8px">
                    <button type="button" data-icon-tab="emoji" class="${icon.type === 'emoji' ? 'active' : ''}">Emoji</button>
                    <button type="button" data-icon-tab="upload" class="${icon.type === 'image' ? 'active' : ''}">Upload</button>
                    <button type="button" data-icon-tab="url" class="${icon.type === 'image' ? 'active' : ''}">URL</button>
                    <button type="button" data-icon-tab="letter" class="${icon.type === 'letter' ? 'active' : ''}">Letter</button>
                  </div>
                  <div id="icon-pane"></div>
                </div>
              </div>
            </div>
            <div class="field"><label>Icon background</label>
              <div class="chips" id="bg-chips">
                ${SWATCHES.map((c) => `<button type="button" class="swatch ${icon.bg === c ? 'selected' : ''}" style="background:${c}" data-bg="${c}"></button>`).join('')}
                <input type="color" id="f-bg" value="${esc(icon.bg || '#2563eb')}">
              </div>
            </div>
            <div class="card" style="padding:12px 14px;box-shadow:none">
              <div class="switch-row"><span><b>Enabled</b><span>App is active for the workspace</span></span>
                <label class="switch"><input type="checkbox" id="f-enabled" ${current.is_enabled ? 'checked' : ''} ${current.is_system ? 'disabled' : ''}><span class="track"></span><span class="thumb"></span></label></div>
              <div class="switch-row"><span><b>Visible on desktop</b><span>Members see the shortcut</span></span>
                <label class="switch"><input type="checkbox" id="f-visible" ${current.is_visible ? 'checked' : ''} ${current.is_system ? 'disabled' : ''}><span class="track"></span><span class="thumb"></span></label></div>
              <div class="switch-row"><span><b>Pin to taskbar &amp; Start</b><span>Also shown in the Start menu grid</span></span>
                <label class="switch"><input type="checkbox" id="f-pinned" ${current.is_pinned ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
            </div>
            ${current.is_system ? '<p class="tiny muted" style="margin-top:10px">This is a protected system app: its name, link, icon and availability are locked.</p>' : ''}
          </div>
        </div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="save-app">${isEdit ? 'Save changes' : 'Create application'}</button>`,
      onMount(root, close) {
        const preview = root.querySelector('#icon-preview');
        const pane = root.querySelector('#icon-pane');

        const drawPreview = () => {
          const bg = icon.bg || 'transparent';
          preview.style.background = bg;
          if (icon.type === 'image' && icon.value) preview.innerHTML = `<img src="${esc(icon.value)}" alt="">`;
          else if (icon.type === 'letter') preview.textContent = String(icon.value || 'D').slice(0, 1).toUpperCase();
          else preview.textContent = icon.value || '📦';
        };
        const drawPane = () => {
          if (icon.type === 'emoji') {
            pane.innerHTML = `<input class="input" id="emoji-input" value="${esc(icon.value || '')}" placeholder="Type or pick an emoji" style="margin-bottom:8px">
              <div class="emoji-grid">${EMOJIS.map((em) => `<button type="button" data-emoji="${em}">${em}</button>`).join('')}</div>`;
            pane.querySelector('#emoji-input').addEventListener('input', (e) => { icon.value = e.target.value; drawPreview(); });
            $$('[data-emoji]', pane).forEach((b) => b.addEventListener('click', () => {
              icon.type = 'emoji'; icon.value = b.dataset.emoji;
              pane.querySelector('#emoji-input').value = icon.value;
              drawPreview();
            }));
          } else if (icon.type === 'upload') {
            pane.innerHTML = `<label class="upload-zone" style="display:block">📤 Click to choose an image (PNG, JPG, WEBP, SVG · max 6 MB)
                <input type="file" accept="image/*" hidden id="icon-file"></label>
              <p class="tiny muted" style="margin:8px 0 0">Uploads are stored in your workspace and referenced by the app record.</p>`;
            pane.querySelector('#icon-file').addEventListener('change', async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              toast('Uploading icon…', { title: 'Upload', timeout: 1800 });
              try {
                const res = await api.upload('/api/admin/uploads/icon', file);
                icon.type = 'image'; icon.value = res.url;
                drawPreview();
                toastOk('Icon uploaded.');
              } catch (err) { toastErr(err.message); }
            });
          } else if (icon.type === 'url') {
            pane.innerHTML = `<input class="input" id="icon-url" value="${esc(icon.type === 'image' ? (icon.value || '') : '')}" placeholder="https://cdn.example.com/icon.png">
              <p class="tiny muted" style="margin:8px 0 0">Paste a direct image URL.</p>`;
            pane.querySelector('#icon-url').addEventListener('input', (e) => { icon.type = 'image'; icon.value = e.target.value; drawPreview(); });
          } else {
            pane.innerHTML = `<input class="input" id="icon-letter" maxlength="2" value="${esc(icon.value || 'D')}" placeholder="D">
              <p class="tiny muted" style="margin:8px 0 0">A single letter or initials on the chosen background colour.</p>`;
            pane.querySelector('#icon-letter').addEventListener('input', (e) => { icon.type = 'letter'; icon.value = e.target.value; drawPreview(); });
          }
        };
        $$('[data-icon-tab]', root).forEach((tab) => tab.addEventListener('click', () => {
          const kind = tab.dataset.iconTab;
          if (kind === 'emoji') { icon.type = 'emoji'; if (!icon.value || icon.value.startsWith('/')) icon.value = '🚀'; }
          if (kind === 'upload' || kind === 'url') { icon.type = 'image'; }
          if (kind === 'letter') { icon.type = 'letter'; icon.value = (root.querySelector('#f-name').value || 'D').slice(0, 1).toUpperCase(); }
          $$('[data-icon-tab]', root).forEach((t) => t.classList.toggle('active', t === tab));
          drawPane(); drawPreview();
        }));
        $$('[data-bg]', root).forEach((b) => b.addEventListener('click', () => {
          icon.bg = b.dataset.bg;
          $$('[data-bg]', root).forEach((x) => x.classList.toggle('selected', x === b));
          root.querySelector('#f-bg').value = icon.bg;
          drawPreview();
        }));
        root.querySelector('#f-bg').addEventListener('input', (e) => { icon.bg = e.target.value; drawPreview(); });

        drawPane();
        drawPreview();

        root.querySelector('#save-app').addEventListener('click', async () => {
          const name = root.querySelector('#f-name').value.trim();
          const url = root.querySelector('#f-url').value.trim();
          if (name.length < 2) return toastErr('App name must be at least 2 characters.');
          if (!url) return toastErr('App link is required.');
          if (!icon.value) return toastErr('Please choose an app icon.');

          const payload = {
            name,
            category: root.querySelector('#f-cat').value.trim() || 'General',
            description: root.querySelector('#f-desc').value.trim(),
            sort_order: Number(root.querySelector('#f-sort').value || 0),
            icon_type: icon.type,
            icon_value: icon.value,
            icon_bg: icon.bg || null,
            is_enabled: root.querySelector('#f-enabled').checked,
            is_visible: root.querySelector('#f-visible').checked,
            is_pinned: root.querySelector('#f-pinned').checked,
          };
          if (!current.is_system) {
            payload.url = url;
            payload.embed_mode = root.querySelector('#f-embed').value;
          }
          try {
            if (isEdit) {
              await api.patch(`/api/admin/apps/${current.id}`, payload);
              toastOk(`“${name}” updated. Members see the change immediately.`);
            } else {
              await api.post('/api/admin/apps', payload);
              toastOk(`“${name}” added — it is already on your members' desktops.`);
            }
            close();
            await viewApps();
            renderSide();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  /* ================================================================== wallpapers */

  async function loadWallpapers() {
    const res = await api.get('/api/admin/wallpapers');
    state.wallpapers = res.wallpapers;
    return res.wallpapers;
  }

  async function viewWallpapers() {
    await loadWallpapers();
    renderWallpapers();
  }

  function renderWallpapers() {
    const view = freshView();
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h2>Wallpapers</h2>
          <p>Members can choose any <strong>active</strong> wallpaper. The default is applied to everyone who has not chosen yet.</p>
        </div>
        <div class="row">
          <button class="btn" data-act="add-css">＋ Gradient wallpaper</button>
          <button class="btn btn-primary" data-act="upload-wp">⬆️ Upload image</button>
        </div>
      </div>

      <div class="admin-wp-grid">
        ${state.wallpapers.map((w) => `
          <article class="admin-wp" data-wp="${w.id}">
            <div class="thumb" style="${w.kind === 'css' ? `background:${esc(w.value)}` : `background-image:url('${esc(w.value)}')`}">
              <div class="flags">
                ${w.is_default ? '<span class="badge badge-accent">Default</span>' : ''}
                ${w.is_enabled ? '<span class="badge badge-good">Active</span>' : '<span class="badge badge-bad">Disabled</span>'}
              </div>
            </div>
            <div class="body">
              <b>${esc(w.name)}</b>
              <p>${esc(w.description || (w.kind === 'css' ? 'CSS gradient' : 'Image'))}</p>
              <p class="tiny muted">Order ${w.sort_order} · added ${esc(fmtDate(w.created_at, false))}</p>
            </div>
            <div class="foot">
              <label class="switch" title="Available to members"><input type="checkbox" data-wp-toggle="${w.id}" ${w.is_enabled ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label>
              <span class="tiny muted">Active</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn btn-sm" data-act="edit-wp" data-id="${w.id}">Edit</button>
              <button class="btn btn-sm btn-subtle" data-act="del-wp" data-id="${w.id}" title="Delete">🗑</button>
            </div>
          </article>`).join('') || `<div class="empty-state" style="grid-column:1/-1"><span class="big">🖼️</span>No wallpapers yet — upload one so your members have a desktop.</div>`}
      </div>`;

    view.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = Number(act.dataset.id);
      if (act.dataset.act === 'upload-wp') return wallpaperUploadModal();
      if (act.dataset.act === 'add-css') return wallpaperModal();
      if (act.dataset.act === 'edit-wp') return wallpaperModal(state.wallpapers.find((w) => w.id === id));
      if (act.dataset.act === 'del-wp') {
        const wp = state.wallpapers.find((w) => w.id === id);
        const yes = await confirmDialog({
          title: `Delete “${wp.name}”?`,
          message: 'Members who selected it fall back to the workspace default wallpaper.',
          confirmLabel: 'Delete wallpaper', danger: true,
        });
        if (!yes) return;
        try {
          await api.del(`/api/admin/wallpapers/${id}`);
          toastOk('Wallpaper deleted.');
          await viewWallpapers();
        } catch (err) { toastErr(err.message); }
      }
    });

    view.addEventListener('change', async (e) => {
      const input = e.target.closest('[data-wp-toggle]');
      if (!input) return;
      try {
        await api.patch(`/api/admin/wallpapers/${input.dataset.wpToggle}`, { is_enabled: input.checked });
        toastOk(input.checked ? 'Wallpaper is now available to members.' : 'Wallpaper hidden from members.');
        await viewWallpapers();
      } catch (err) { input.checked = !input.checked; toastErr(err.message); }
    });
  }

  function wallpaperUploadModal() {
    modal({
      title: 'Upload a wallpaper',
      body: `
        <div class="field"><label for="wp-name">Wallpaper name</label><input class="input" id="wp-name" placeholder="e.g. Graphite Ridges"></div>
        <div class="field"><label for="wp-desc">Details</label><input class="input" id="wp-desc" placeholder="Short description for members"></div>
        <div class="field"><label>Image file</label>
          <label class="upload-zone" style="display:block">📤 Choose an image (PNG, JPG, WEBP, SVG or AVIF · max 6 MB)
            <input type="file" accept="image/*" hidden id="wp-file"></label>
          <div id="wp-preview" style="margin-top:12px"></div></div>
        <label class="check"><input type="checkbox" id="wp-default"> <span>Make this the workspace default wallpaper</span></label>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="wp-save">Upload wallpaper</button>',
      onMount(root, close) {
        root.querySelector('#wp-file').addEventListener('change', (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          root.querySelector('#wp-preview').innerHTML = `<div class="wp-thumb" style="height:140px;border-radius:10px;background-image:url('${URL.createObjectURL(file)}')"></div>`;
          if (!root.querySelector('#wp-name').value) root.querySelector('#wp-name').value = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
        });
        root.querySelector('#wp-save').addEventListener('click', async () => {
          const file = root.querySelector('#wp-file').files?.[0];
          if (!file) return toastErr('Choose an image file first.');
          try {
            await api.upload('/api/admin/wallpapers/upload', file, {
              name: root.querySelector('#wp-name').value.trim() || 'Uploaded wallpaper',
              description: root.querySelector('#wp-desc').value.trim(),
              is_default: root.querySelector('#wp-default').checked ? '1' : '0',
            });
            toastOk('Wallpaper added and available to members.');
            close();
            await viewWallpapers();
            renderSide();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  function wallpaperModal(wp) {
    const isEdit = !!wp;
    modal({
      title: isEdit ? `Edit “${wp.name}”` : 'Add a gradient wallpaper',
      body: `
        <div class="field"><label for="ew-name">Name</label><input class="input" id="ew-name" value="${esc(wp?.name || '')}" placeholder="e.g. Dexter Midnight"></div>
        <div class="field"><label for="ew-desc">Details</label><input class="input" id="ew-desc" value="${esc(wp?.description || '')}" placeholder="Short description"></div>
        <div class="field"><label for="ew-value">CSS background value</label>
          <textarea class="textarea" id="ew-value" placeholder="linear-gradient(160deg, #070b16, #0b1226)">${esc(wp && wp.kind === 'css' ? wp.value : '')}</textarea>
          <span class="hint">Any valid CSS background: gradients, colours or a url(...) reference.</span></div>
        ${isEdit && wp.kind === 'image' ? `<p class="tiny muted">This wallpaper uses an uploaded image: <code>${esc(wp.value)}</code></p>` : ''}
        <div class="grid-2">
          <div class="field"><label for="ew-order">Sort order</label><input class="input" id="ew-order" type="number" value="${Number(wp?.sort_order ?? 100)}"></div>
          <div class="field" style="justify-content:flex-end">
            <label class="check" style="margin-top:auto"><input type="checkbox" id="ew-default" ${wp?.is_default ? 'checked' : ''}> <span>Workspace default</span></label>
            <label class="check"><input type="checkbox" id="ew-enabled" ${wp?.is_enabled !== false ? 'checked' : ''}> <span>Available to members</span></label>
          </div>
        </div>
        <div id="ew-preview"></div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="ew-save">Save wallpaper</button>',
      onMount(root, close) {
        const draw = () => {
          const value = root.querySelector('#ew-value').value.trim();
          root.querySelector('#ew-preview').innerHTML = value && !value.includes('<')
            ? `<div style="height:120px;border-radius:12px;border:1px solid var(--stroke);background:${value}"></div>` : '';
        };
        root.querySelector('#ew-value').addEventListener('input', draw);
        if (isEdit) draw();
        root.querySelector('#ew-save').addEventListener('click', async () => {
          const name = root.querySelector('#ew-name').value.trim();
          const value = root.querySelector('#ew-value').value.trim();
          if (name.length < 2) return toastErr('Give the wallpaper a name.');
          const payload = {
            name,
            description: root.querySelector('#ew-desc').value.trim(),
            sort_order: Number(root.querySelector('#ew-order').value || 100),
            is_enabled: root.querySelector('#ew-enabled').checked,
            is_default: root.querySelector('#ew-default').checked,
          };
          if (value) { payload.value = value; payload.kind = 'css'; }
          else if (!isEdit) return toastErr('Enter a CSS background value.');
          try {
            if (isEdit) await api.patch(`/api/admin/wallpapers/${wp.id}`, payload);
            else await api.post('/api/admin/wallpapers', payload);
            toastOk(isEdit ? 'Wallpaper updated.' : 'Wallpaper added.');
            close();
            await viewWallpapers();
            renderSide();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  /* ================================================================== members */

  async function loadUsers() {
    const params = new URLSearchParams();
    if (state.filters.userQuery) params.set('q', state.filters.userQuery);
    if (state.filters.userStatus !== 'all') params.set('status', state.filters.userStatus);
    if (state.filters.userRole !== 'all') params.set('role', state.filters.userRole);
    const res = await api.get(`/api/admin/users?${params.toString()}`);
    state.users = res.users;
    state.summary = res.summary;
    return res;
  }

  async function viewUsers() {
    await loadUsers();
    renderUsers();
  }

  function renderUsers() {
    const view = freshView();
    const meId = state.session.user.id;
    view.innerHTML = `
      <div class="view-head">
        <div>
          <h2>Members</h2>
          <p>${state.summary.total} account${state.summary.total === 1 ? '' : 's'} · ${state.summary.active} active ·
             ${state.summary.disabled} suspended · ${state.summary.admins} administrator${state.summary.admins === 1 ? '' : 's'}</p>
        </div>
        <button class="btn btn-primary" data-act="new-user">＋ Add member</button>
      </div>

      <div class="toolbar">
        <input class="input" id="user-q" placeholder="Search by name, email or job title…" value="${esc(state.filters.userQuery)}">
        <select class="select" id="user-status">
          <option value="all" ${state.filters.userStatus === 'all' ? 'selected' : ''}>Any status</option>
          <option value="active" ${state.filters.userStatus === 'active' ? 'selected' : ''}>Active</option>
          <option value="disabled" ${state.filters.userStatus === 'disabled' ? 'selected' : ''}>Suspended</option>
        </select>
        <select class="select" id="user-role">
          <option value="all" ${state.filters.userRole === 'all' ? 'selected' : ''}>Any role</option>
          <option value="owner" ${state.filters.userRole === 'owner' ? 'selected' : ''}>Owner</option>
          <option value="admin" ${state.filters.userRole === 'admin' ? 'selected' : ''}>Administrator</option>
          <option value="user" ${state.filters.userRole === 'user' ? 'selected' : ''}>Member</option>
        </select>
        <span class="spacer"></span>
        <span class="tiny muted">${state.users.length} shown</span>
      </div>

      <div class="card" style="overflow:hidden">
        <table class="table">
          <thead><tr><th style="width:30%">Member</th><th>Role</th><th>Status</th><th>Sessions</th><th>Launches</th><th>Last sign-in</th><th style="width:200px;text-align:right">Actions</th></tr></thead>
          <tbody>
            ${state.users.map((u) => `
              <tr data-user-row="${u.id}">
                <td><div class="app-cell">${avatar(u, '')}
                  <span class="meta"><b>${esc(u.name)} ${u.id === meId ? '<span class="badge">You</span>' : ''}</b>
                  <span>${esc(u.email)}${u.title ? ` · ${esc(u.title)}` : ''}</span></span></div></td>
                <td>
                  <select class="select" style="min-width:120px" data-role="${u.id}" ${u.role === 'owner' && meId !== u.id ? 'disabled' : ''}>
                    <option value="user" ${u.role === 'user' ? 'selected' : ''}>Member</option>
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option>
                    ${u.role === 'owner' ? '<option value="owner" selected>Owner</option>' : ''}
                  </select>
                </td>
                <td><label class="switch" title="Activate or suspend this account"><input type="checkbox" data-status="${u.id}" ${u.status === 'active' ? 'checked' : ''} ${u.id === meId ? 'disabled' : ''}><span class="track"></span><span class="thumb"></span></label>
                  <span class="tiny muted" style="margin-left:6px">${u.status === 'active' ? 'Active' : 'Suspended'}</span></td>
                <td class="small">${u.active_sessions}</td>
                <td class="small">${u.launches}</td>
                <td class="small">${esc(u.last_login_at ? timeAgo(u.last_login_at) : 'never')}</td>
                <td><div class="actions">
                  <button class="btn btn-sm" data-act="profile" data-id="${u.id}">Profile</button>
                  <button class="btn btn-sm btn-subtle" data-act="reset" data-id="${u.id}" title="Reset password">🔑</button>
                  ${u.id === meId ? '' : `<button class="btn btn-sm btn-subtle" data-act="delete" data-id="${u.id}" title="Delete account">🗑</button>`}
                </div></td>
              </tr>`).join('') || '<tr><td colspan="7"><div class="empty-state"><span class="big">👥</span>No members match these filters.</div></td></tr>'}
          </tbody>
        </table>
      </div>

      <p class="tiny muted" style="margin-top:12px">Suspending an account signs the member out everywhere. The last active administrator of a workspace cannot be
        suspended, demoted or deleted.</p>`;

    let timer;
    $('#user-q').addEventListener('input', (e) => {
      clearTimeout(timer);
      state.filters.userQuery = e.target.value;
      timer = setTimeout(async () => { await loadUsers(); renderUsers(); $('#user-q').focus(); }, 300);
    });
    $('#user-status').addEventListener('change', async (e) => { state.filters.userStatus = e.target.value; await loadUsers(); renderUsers(); });
    $('#user-role').addEventListener('change', async (e) => { state.filters.userRole = e.target.value; await loadUsers(); renderUsers(); });

    view.addEventListener('change', async (e) => {
      const roleSel = e.target.closest('[data-role]');
      const statusSw = e.target.closest('[data-status]');
      try {
        if (roleSel) {
          await api.patch(`/api/admin/users/${roleSel.dataset.role}`, { role: roleSel.value });
          toastOk('Role updated.');
          await viewUsers();
        }
        if (statusSw) {
          await api.patch(`/api/admin/users/${statusSw.dataset.status}`, { status: statusSw.checked });
          toastOk(statusSw.checked ? 'Account reactivated.' : 'Account suspended and signed out.');
          await viewUsers();
        }
      } catch (err) { toastErr(err.message); await viewUsers(); }
    });

    view.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = Number(act.dataset.id);
      const user = state.users.find((u) => u.id === id);
      if (act.dataset.act === 'new-user') return newUserModal();
      if (act.dataset.act === 'profile') return profileModal(user);
      if (act.dataset.act === 'reset') return resetPasswordModal(user);
      if (act.dataset.act === 'delete') {
        const yes = await confirmDialog({
          title: `Delete ${user.name}?`,
          message: `This permanently removes ${user.email}, their preferences and their app usage from this workspace.`,
          confirmLabel: 'Delete account', danger: true,
        });
        if (!yes) return;
        try {
          await api.del(`/api/admin/users/${id}`);
          toastOk('Account deleted.');
          await viewUsers();
        } catch (err) { toastErr(err.message); }
      }
    });
  }

  function newUserModal() {
    modal({
      title: 'Add a member',
      body: `
        <div class="field"><label for="nu-name">Full name</label><input class="input" id="nu-name" placeholder="Alex Morgan"></div>
        <div class="field"><label for="nu-email">Work email</label><input class="input" id="nu-email" type="email" placeholder="alex@company.com"></div>
        <div class="field"><label for="nu-title">Job title</label><input class="input" id="nu-title" placeholder="Optional"></div>
        <div class="grid-2">
          <div class="field"><label for="nu-role">Role</label><select class="select" id="nu-role"><option value="user">Member</option><option value="admin">Administrator</option></select></div>
          <div class="field"><label for="nu-pw">Temporary password</label><input class="input" id="nu-pw" value="Dexter${Math.floor(1000 + Math.random() * 9000)}" ></div>
        </div>
        <p class="tiny muted">Share the temporary password securely — the member can change it in Settings → Security.</p>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nu-save">Create account</button>',
      onMount(root, close) {
        root.querySelector('#nu-save').addEventListener('click', async () => {
          try {
            const res = await api.post('/api/admin/users', {
              name: root.querySelector('#nu-name').value.trim(),
              email: root.querySelector('#nu-email').value.trim(),
              title: root.querySelector('#nu-title').value.trim(),
              role: root.querySelector('#nu-role').value,
              password: root.querySelector('#nu-pw').value,
            });
            toastOk(`${res.user.name} can now sign in with the temporary password.`);
            close();
            await viewUsers();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  async function profileModal(user) {
    const detail = await api.get(`/api/admin/users/${user.id}`);
    const d = detail.user;
    modal({
      title: `${d.name} — profile`,
      wide: true,
      body: `
        <div class="row" style="gap:16px;flex-wrap:wrap;margin-bottom:16px">
          ${avatar(d, 'lg')}
          <div class="grow" style="min-width:220px">
            <h3 style="margin:0 0 2px">${esc(d.name)}</h3>
            <div class="small muted">${esc(d.email)}${d.title ? ` · ${esc(d.title)}` : ''}</div>
            <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
              <span class="badge ${d.status === 'active' ? 'badge-good' : 'badge-bad'}">${d.status === 'active' ? 'Active' : 'Suspended'}</span>
              <span class="badge badge-accent">${esc(d.role)}</span>
              <span class="badge">${d.launches} launches</span>
            </div>
          </div>
          <div class="tiny muted" style="text-align:right">
            Joined ${esc(fmtDate(d.created_at, false))}<br>
            Last sign-in ${esc(d.last_login_at ? fmtDate(d.last_login_at) : 'never')}<br>
            Phone ${esc(d.phone || '—')}
          </div>
        </div>

        <div class="grid-2">
          <div>
            <h4 style="font-size:13px">Desktop preferences</h4>
            <div class="stack small">
              <div class="row-between"><span class="muted">Theme</span><span>${esc(detail.settings.theme)}</span></div>
              <div class="row-between"><span class="muted">Accent</span><span><span class="swatch" style="display:inline-block;width:14px;height:14px;background:${esc(detail.settings.accent)};vertical-align:-2px"></span> ${esc(detail.settings.accent)}</span></div>
              <div class="row-between"><span class="muted">Icon size</span><span>${esc(detail.settings.icon_size)}</span></div>
              <div class="row-between"><span class="muted">Taskbar</span><span>${esc(detail.settings.taskbar_align)}</span></div>
              <div class="row-between"><span class="muted">Wallpaper</span><span>${esc(detail.wallpaper?.name || 'workspace default')}</span></div>
            </div>
          </div>
          <div>
            <h4 style="font-size:13px">Most used apps</h4>
            <div class="stack small">
              ${detail.usage.length ? detail.usage.map((u) => `
                <div class="row-between"><span class="truncate">${esc(u.name)}</span><span class="muted tiny">${u.open_count} · ${esc(timeAgo(u.last_opened_at))}</span></div>`).join('')
                : '<p class="tiny muted">No app usage recorded.</p>'}
            </div>
          </div>
        </div>

        <h4 style="font-size:13px;margin-top:16px">Active sessions</h4>
        <div class="session-list small">
          ${detail.sessions.length ? detail.sessions.map((s) => `
            <div class="row-between" style="border-bottom:1px solid var(--stroke);padding:7px 0">
              <span class="truncate" style="max-width:60%"><code>${esc(String(s.user_agent || 'unknown device').slice(0, 60))}</code></span>
              <span class="tiny muted">${esc(s.ip || '')} · since ${esc(timeAgo(s.created_at))}</span>
            </div>`).join('') : '<p class="tiny muted">No active sessions.</p>'}
        </div>

        <h4 style="font-size:13px;margin-top:16px">Recent activity</h4>
        <div class="activity">
          ${detail.activity.length ? detail.activity.map((a) => `
            <div class="item"><span class="ico">${activityIcon(a.action)}</span>
              <span><b>${esc(humanAction(a.action))}</b><span>${esc(a.detail || '')}</span></span>
              <time>${esc(timeAgo(a.created_at))}</time></div>`).join('') : '<p class="tiny muted">Nothing recorded yet.</p>'}
        </div>`,
      footer: '<button class="btn" data-close>Close</button><button class="btn btn-primary" id="pm-edit">Edit account</button>',
      onMount(root, close) {
        root.querySelector('#pm-edit').addEventListener('click', () => { close(); editUserModal(d); });
      },
    });
  }

  function editUserModal(user) {
    modal({
      title: `Edit ${user.name}`,
      body: `
        <div class="field"><label for="eu-name">Full name</label><input class="input" id="eu-name" value="${esc(user.name)}"></div>
        <div class="field"><label for="eu-email">Email</label><input class="input" id="eu-email" type="email" value="${esc(user.email)}"></div>
        <div class="grid-2">
          <div class="field"><label for="eu-title">Job title</label><input class="input" id="eu-title" value="${esc(user.title || '')}"></div>
          <div class="field"><label for="eu-phone">Phone</label><input class="input" id="eu-phone" value="${esc(user.phone || '')}"></div>
        </div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="eu-save">Save changes</button>',
      onMount(root, close) {
        root.querySelector('#eu-save').addEventListener('click', async () => {
          try {
            await api.patch(`/api/admin/users/${user.id}`, {
              name: root.querySelector('#eu-name').value.trim(),
              email: root.querySelector('#eu-email').value.trim(),
              title: root.querySelector('#eu-title').value.trim(),
              phone: root.querySelector('#eu-phone').value.trim(),
            });
            toastOk('Member profile updated.');
            close();
            await viewUsers();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  function resetPasswordModal(user) {
    const suggested = `Dexter${Math.floor(100000 + Math.random() * 900000)}`;
    modal({
      title: `Reset password for ${user.name}`,
      body: `<p class="small muted">All of their active sessions are signed out when the password changes.</p>
        <div class="field"><label for="rp-pw">New password</label><input class="input" id="rp-pw" value="${suggested}">
        <span class="hint">At least 8 characters with letters and numbers.</span></div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="rp-save">Reset password</button>',
      onMount(root, close) {
        root.querySelector('#rp-save').addEventListener('click', async () => {
          try {
            const res = await api.post(`/api/admin/users/${user.id}/reset-password`, { new_password: root.querySelector('#rp-pw').value });
            toastOk(res.message || 'Password reset.');
            close();
          } catch (err) { toastErr(err.message); }
        });
      },
    });
  }

  /* ================================================================== activity */

  async function viewActivity() {
    const view = freshView();
    const res = await api.get('/api/admin/activity?limit=150');
    view.innerHTML = `
      <div class="view-head">
        <div><h2>Activity</h2><p>An audit trail of what administrators and members did in this workspace.</p></div>
        <button class="btn" data-act="reload">🔄 Refresh</button>
      </div>
      <div class="card" style="overflow:hidden">
        <table class="table">
          <thead><tr><th style="width:180px">When</th><th style="width:220px">Action</th><th>Detail</th><th style="width:220px">Actor</th></tr></thead>
          <tbody>
            ${res.activity.map((a) => `
              <tr>
                <td class="small">${esc(timeAgo(a.created_at))}<div class="sub">${esc(fmtDate(a.created_at))}</div></td>
                <td><span class="badge">${esc(humanAction(a.action))}</span></td>
                <td class="small">${esc(a.detail || '')}</td>
                <td class="small">${esc(a.actor || 'system')}</td>
              </tr>`).join('') || '<tr><td colspan="4"><div class="empty-state"><span class="big">🕓</span>No activity yet.</div></td></tr>'}
          </tbody>
        </table>
      </div>`;
    view.addEventListener('click', (e) => { if (e.target.closest('[data-act="reload"]')) viewActivity(); }, { once: true });
  }

  /* ================================================================== workspace */

  async function viewWorkspace() {
    const view = freshView();
    await loadApps();
    await loadWallpapers();
    const t = state.session.tenant;
    const s = state.overview?.stats;
    view.innerHTML = `
      <div class="view-head">
        <div><h2>Workspace</h2><p>Tenant-level settings for ${esc(t.name)}.</p></div>
      </div>
      <div class="grid-split">
        <div class="card" style="padding:20px">
          <h3 style="font-size:15px">General</h3>
          <div class="field"><label for="ws-name">Workspace name</label><input class="input" id="ws-name" value="${esc(t.name)}"></div>
          <div class="field"><label for="ws-max">Member limit</label><input class="input" id="ws-max" type="number" min="1" max="5000" value="${Number(t.max_users || 50)}"></div>
          <div class="switch-row"><span><b>Allow joining with the workspace code</b><span>Turn off to stop new registrations (existing members are unaffected)</span></span>
            <label class="switch"><input type="checkbox" id="ws-join" ${t.allow_join ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>
          <div class="row" style="margin-top:16px"><button class="btn btn-primary" id="ws-save">Save workspace settings</button></div>
        </div>

        <div class="stack">
          <div class="card" style="padding:20px">
            <h3 style="font-size:15px">Invite code</h3>
            <p class="small muted">Share this code so teammates can register directly into ${esc(t.name)}.</p>
            <div class="row"><code class="badge" style="font-size:15px;padding:8px 14px">${esc(t.join_code || '—')}</code>
              <button class="btn btn-sm" data-act="copy-code">Copy code</button></div>
            <p class="tiny muted" style="margin-top:10px">Registration link: <code>${esc(location.origin)}/register</code></p>
          </div>
          <div class="card" style="padding:20px">
            <h3 style="font-size:15px">Tenant summary</h3>
            <div class="stack small">
              <div class="row-between"><span class="muted">Plan</span><span class="badge badge-accent">${esc(String(t.plan || 'pro').toUpperCase())}</span></div>
              <div class="row-between"><span class="muted">Members</span><span>${s ? s.users : '—'} / ${Number(t.max_users || 50)}</span></div>
              <div class="row-between"><span class="muted">Applications</span><span>${state.apps.length} (${state.apps.filter((a) => a.is_enabled && a.is_visible).length} visible)</span></div>
              <div class="row-between"><span class="muted">Wallpapers</span><span>${state.wallpapers.length} (${state.wallpapers.filter((w) => w.is_enabled).length} active)</span></div>
              <div class="row-between"><span class="muted">Workspace slug</span><span>${esc(t.slug || '')}</span></div>
            </div>
          </div>
        </div>
      </div>`;

    view.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act="copy-code"]')) {
        try { await navigator.clipboard.writeText(t.join_code); toastOk('Join code copied.'); } catch { toastErr('Clipboard blocked by the browser.'); }
      }
      if (e.target.closest('#ws-save')) {
        try {
          const res = await api.patch('/api/admin/workspace', {
            name: $('#ws-name').value.trim(),
            max_users: Number($('#ws-max').value || 50),
            allow_join: $('#ws-join').checked,
          });
          state.session.tenant = { ...state.session.tenant, ...res.workspace };
          toastOk('Workspace settings saved.');
          renderSide();
        } catch (err) { toastErr(err.message); }
      }
    });
  }

  /* ================================================================== gate & boot */

  async function gate() {
    try {
      const session = await api.get('/api/auth/session');
      if (!(session.user.role === 'admin' || session.user.role === 'owner')) {
        renderGate(session, 'Your account does not have administrator access to this workspace.');
        return false;
      }
      state.session = session;
      return true;
    } catch (err) {
      renderGate(null, err.status === 401 ? 'Sign in with an administrator account to continue.' : err.message);
      return false;
    }
  }

  function renderGate(session, message) {
    $('#admin-app').classList.add('hiddenish');
    const host = document.createElement('div');
    host.id = 'admin-gate';
    host.innerHTML = `
      <div class="card" style="width:min(430px,100%);padding:26px">
        <div class="row" style="gap:10px;margin-bottom:16px">
          <span class="brand-mark" style="width:34px;height:34px;border-radius:9px">D</span>
          <div><b>DexterOS admin console</b><div class="tiny muted">${esc(session ? session.tenant.name : 'Administrator access required')}</div></div>
        </div>
        <p class="small muted">${esc(message)}</p>
        ${session ? '' : `
        <form id="gate-form">
          <div class="field"><label for="g-email">Email</label><input class="input" id="g-email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="g-pw">Password</label><input class="input" id="g-pw" type="password" autocomplete="current-password" required></div>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>`}
        <div class="row" style="margin-top:16px;gap:8px">
          <a class="btn btn-sm" href="/app">Open my desktop</a>
          ${session ? '<button class="btn btn-sm btn-subtle" id="gate-switch">Use another account</button>' : '<a class="btn btn-sm btn-subtle" href="/">Back to homepage</a>'}
        </div>
      </div>`;
    document.body.appendChild(host);

    $('#gate-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api.post('/api/auth/login', { email: $('#g-email').value, password: $('#g-pw').value });
        store.token = data.token;
        if (data.user.role !== 'admin' && data.user.role !== 'owner') {
          toastErr('That account is not an administrator of this workspace.');
          return;
        }
        location.reload();
      } catch (err) { toastErr(err.message); }
    });
    $('#gate-switch')?.addEventListener('click', async () => {
      try { await api.post('/api/auth/logout', {}); } catch { /* ignore */ }
      store.clear();
      location.reload();
    });
  }

  async function boot() {
    $('#side-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (btn) go(btn.dataset.view);
    });
    $('#signout').addEventListener('click', async () => {
      const yes = await confirmDialog({ title: 'Sign out?', message: 'You will be returned to the homepage.', confirmLabel: 'Sign out' });
      if (!yes) return;
      try { await api.post('/api/auth/logout', {}); } catch { /* ignore */ }
      store.clear();
      location.href = '/';
    });

    const ok = await gate();
    if (!ok) return;

    // Preload counters for the sidebar, then render the requested view.
    try {
      const [apps, wallpapers] = await Promise.all([loadApps(), loadWallpapers()]);
      state.apps = apps;
      state.wallpapers = wallpapers;
      const users = await loadUsers();
      state.summary = users.summary;
    } catch { /* views handle their own errors */ }

    const hash = (location.hash || '').replace('#', '');
    const initial = VIEWS.some((v) => v.id === hash) ? hash : 'overview';
    renderSide();
    await go(initial);
  }

  boot();
}());
