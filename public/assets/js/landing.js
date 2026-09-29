/* ==========================================================================
   DexterOS — landing page behaviour.
   Auth modal (sign in / register / join with code), deployment-aware messaging
   and session redirects. No demo credentials exist in a production deployment:
   the first workspace is created once, through /setup.
   ========================================================================== */
(function () {
  'use strict';
  const { api, esc, toastOk, store } = window.DX;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Deployment state reported by /api/system/status (public, no secrets). */
  const deployment = { ready: false, setupRequired: false, registrationMode: 'closed', checks: [], serviceName: 'DexterOS' };

  document.documentElement.dataset.theme = localStorage.getItem('dexteros.theme') || 'light';

  function fieldError(form, message) {
    let box = form.querySelector('.form-error');
    if (!box) {
      box = document.createElement('p');
      box.className = 'form-error';
      form.prepend(box);
    }
    box.textContent = message || '';
    return box;
  }

  function busy(button, isBusy, label) {
    if (!button) return;
    if (isBusy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span> ${esc(label || 'Please wait…')}`;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  /* -------------------------------------------------- deployment awareness */
  function applyDeploymentUi() {
    const banner = $('#setup-banner');
    if (banner) {
      banner.classList.toggle('hiddenish', !deployment.setupRequired);
      if (deployment.setupRequired) {
        const blocked = deployment.checks?.find((c) => !c.ok);
        $('#setup-banner-detail').textContent = blocked ? blocked.detail : 'This deployment has no workspace yet.';
      }
    }

    // Registration closed (the production default): steer visitors towards join codes.
    const closed = deployment.registrationMode !== 'open';
    $$('[data-cta]').forEach((el) => {
      if (deployment.setupRequired) {
        el.textContent = 'Finish setup';
        el.dataset.auth = 'setup';
      }
    });
    if (closed && !deployment.setupRequired) {
      // Invite-only deployment: keep a strong call to action instead of hiding it.
      $$('[data-requires-open]').forEach((el) => {
        el.classList.remove('hiddenish');
        el.textContent = 'Join with code';
        el.dataset.auth = 'register';
      });
      $$('[data-cta]').forEach((el) => { if (el.dataset.auth !== 'setup') el.textContent = 'Join a workspace'; });
      $$('[data-open-note]').forEach((el) => el.classList.remove('hiddenish'));
    }
  }

  async function loadDeployment() {
    try {
      const status = await api.get('/api/system/status');
      deployment.ready = status.database?.connected && !status.setup_required;
      deployment.setupRequired = !!status.setup_required;
      deployment.registrationMode = status.registration_mode || 'closed';
      deployment.checks = status.checks || [];
      deployment.serviceName = status.service?.name || 'DexterOS';
    } catch {
      deployment.setupRequired = false;
    }
    applyDeploymentUi();
  }

  /* ---------------------------------------------------------------- auth ui */
  function openAuth(tab = 'login') {
    if (tab === 'setup') { location.href = '/setup'; return; }
    const body = `
      <div class="auth-tabs">
        <button data-tab="login" class="${tab === 'login' ? 'active' : ''}">Sign in</button>
        <button data-tab="register" class="${tab === 'register' ? 'active' : ''}">Create account</button>
      </div>
      <div id="auth-panel"></div>`;
    window.DX.modal({ title: `Welcome to ${deployment.serviceName}`, body, onMount: (root) => {
      $$('[data-tab]', root).forEach((btn) => btn.addEventListener('click', () => {
        $$('[data-tab]', root).forEach((b) => b.classList.toggle('active', b === btn));
        renderPanel(btn.dataset.tab, root);
      }));
      renderPanel(deployment.setupRequired ? 'register' : tab, root);
    } });
  }

  function loginPanel(root) {
    const panel = $('#auth-panel', root);
    panel.innerHTML = `
      <form id="login-form">
        <div class="field">
          <label for="li-email">Work email</label>
          <input class="input" id="li-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com">
        </div>
        <div class="field">
          <label for="li-password">Password</label>
          <input class="input" id="li-password" name="password" type="password" autocomplete="current-password" required placeholder="Your password">
        </div>
        <div class="field">
          <label for="li-workspace">Workspace code <span class="muted">(only if this email is used in more than one workspace)</span></label>
          <input class="input" id="li-workspace" name="workspace" placeholder="e.g. DX-4F2K9A" autocomplete="off">
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button>
      </form>`;
    const form = $('#login-form', panel);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      fieldError(form, '');
      const submit = form.querySelector('[type="submit"]');
      busy(submit, true, 'Signing in…');
      try {
        const data = await api.post('/api/auth/login', {
          email: $('#li-email', form).value,
          password: $('#li-password', form).value,
          workspace: $('#li-workspace', form).value,
        });
        store.token = data.token;
        toastOk(`Signed in as ${data.user.name}`);
        location.href = data.user.role === 'user' ? '/app' : '/admin';
      } catch (err) {
        fieldError(form, err.message);
        busy(submit, false);
      }
    });
  }

  function registerPanel(root) {
    const panel = $('#auth-panel', root);
    const open = deployment.registrationMode === 'open';
    panel.innerHTML = `
      <form id="register-form">
        <div class="workspace-choice">
          ${open ? `<label><input type="radio" name="mode" value="create" checked><span><b>New workspace</b><small>You become the owner &amp; administrator</small></span></label>` : ''}
          <label><input type="radio" name="mode" value="join" ${open ? '' : 'checked'}><span><b>Join with code</b><small>Enter your team's workspace join code</small></span></label>
        </div>
        ${open ? '' : '<p class="hint" data-open-note>Self-service workspaces are disabled on this deployment. Ask an administrator for a workspace join code — they can also invite you directly from the admin console.</p>'}
        <div class="field ${open ? '' : 'hiddenish'}" data-only="create">
          <label for="rg-workspace">Workspace name</label>
          <input class="input" id="rg-workspace" placeholder="Acme Corp">
        </div>
        <div class="field ${open ? 'hiddenish' : ''}" data-only="join">
          <label for="rg-code">Workspace join code</label>
          <input class="input" id="rg-code" placeholder="DX-XXXXXX" autocomplete="off">
          <div class="workspace-preview" id="ws-preview"></div>
        </div>
        <div class="field">
          <label for="rg-name">Full name</label>
          <input class="input" id="rg-name" autocomplete="name" required placeholder="Jane Cooper">
        </div>
        <div class="field">
          <label for="rg-email">Work email</label>
          <input class="input" id="rg-email" type="email" autocomplete="email" required placeholder="jane@company.com">
        </div>
        <div class="field">
          <label for="rg-password">Password</label>
          <input class="input" id="rg-password" type="password" autocomplete="new-password" required placeholder="At least 10 characters">
          <span class="hint">Minimum 10 characters with at least one letter and one number.</span>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">${open ? 'Create my account' : 'Join workspace'}</button>
      </form>`;

    const form = $('#register-form', panel);
    const syncMode = () => {
      const checked = form.querySelector('input[name="mode"]:checked');
      const mode = checked ? checked.value : 'join';
      $$('[data-only]', form).forEach((el) => el.classList.toggle('hiddenish', el.dataset.only !== mode));
    };
    $$('input[name="mode"]', form).forEach((r) => r.addEventListener('change', syncMode));
    syncMode();

    let lookupTimer;
    $('#rg-code', form).addEventListener('input', (e) => {
      clearTimeout(lookupTimer);
      const code = e.target.value.trim();
      const preview = $('#ws-preview', form);
      if (!code) { preview.innerHTML = ''; return; }
      lookupTimer = setTimeout(async () => {
        try {
          const res = await api.get(`/api/auth/workspace/${encodeURIComponent(code)}`);
          preview.innerHTML = `<span class="badge badge-good">Found</span> <strong>${esc(res.name)}</strong>
            <span class="muted">· ${res.members} member${res.members === 1 ? '' : 's'}${res.joinable ? '' : ' · not accepting joins'}</span>`;
        } catch (err) {
          preview.innerHTML = `<span class="badge badge-bad">${esc(err.message)}</span>`;
        }
      }, 350);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      fieldError(form, '');
      const checked = form.querySelector('input[name="mode"]:checked');
      const mode = checked ? checked.value : 'join';
      const submit = form.querySelector('[type="submit"]');
      busy(submit, true, mode === 'create' ? 'Creating your workspace…' : 'Joining…');
      try {
        const data = await api.post('/api/auth/register', {
          mode,
          workspace_name: $('#rg-workspace', form).value,
          workspace_code: $('#rg-code', form).value,
          name: $('#rg-name', form).value,
          email: $('#rg-email', form).value,
          password: $('#rg-password', form).value,
        });
        store.token = data.token;
        toastOk(mode === 'create' ? `Workspace "${data.tenant.name}" is ready.` : `Welcome to ${data.tenant.name}.`);
        location.href = mode === 'create' ? '/admin' : '/app';
      } catch (err) {
        fieldError(form, err.message);
        busy(submit, false);
      }
    });
  }

  function renderPanel(tab, root) {
    if (tab === 'login') loginPanel(root);
    else registerPanel(root);
  }

  /* ---------------------------------------------------------------- wiring */
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-auth]');
    if (!trigger) return;
    e.preventDefault();
    openAuth(trigger.dataset.auth || 'login');
  });

  $('#mobile-menu')?.addEventListener('click', () => {
    document.querySelector('.nav-links')?.classList.toggle('nav-links-open');
  });

  (async () => {
    await loadDeployment();
    if (!store.token) return;
    try {
      const session = await api.get('/api/auth/session');
      const banner = document.getElementById('session-banner');
      if (banner) {
        banner.classList.remove('hiddenish');
        banner.querySelector('[data-session-name]').textContent = `Signed in as ${session.user.name} · ${session.tenant.name}`;
        const open = banner.querySelector('[data-open-console]');
        if (open) open.href = session.user.role === 'user' ? '/app' : '/admin';
      }
      $$('[data-cta]').forEach((el) => { el.textContent = 'Open my console'; });
    } catch {
      store.clear();
    }
  })();

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
}());
