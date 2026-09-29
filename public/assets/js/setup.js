/* ==========================================================================
   DexterOS — first-run setup & deployment diagnostics.
   Talks to /api/system/* which works even before a database is bound, so this
   page can always explain what still needs configuring in Cloudflare.
   ========================================================================== */
(function () {
  'use strict';
  const { api, esc, toastOk, toastErr, store } = window.DX;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const status = { data: null };

  function checkRow(check) {
    const ok = check.ok;
    const badge = ok
      ? '<span class="badge badge-good">Connected</span>'
      : '<span class="badge badge-bad">Action needed</span>';
    return `<div class="row" style="align-items:flex-start;gap:12px">
      <span style="font-size:18px">${ok ? '✅' : '⚠️'}</span>
      <div class="grow">
        <div class="row" style="gap:8px"><strong class="small">${esc(check.label)}</strong>${badge}</div>
        <div class="tiny muted" style="margin-top:2px">${esc(check.detail || '')}</div>
      </div>
    </div>`;
  }

  function render(data) {
    status.data = data;

    const checks = $('#checks');
    const databaseOk = !!(data.database && data.database.connected);
    checks.innerHTML = (data.checks || []).map(checkRow).join('') || '<p class="small muted">No checks reported.</p>';

    const service = data.service?.name || 'DexterOS';
    document.title = `Setup · ${service}`;

    const steps = $('#setup-steps');
    const allOk = (data.checks || []).every((c) => c.ok);
    steps.classList.toggle('hiddenish', allOk);

    // A locked Pages dashboard is the one failure mode the app cannot detect
    // itself, so the hint is shown whenever a binding is missing.
    $('#binding-hint').classList.toggle('hiddenish', allOk);

    $('#storage-note').textContent = data.storage?.available
      ? 'Uploaded icons and wallpapers are served from your own domain at /media/…'
      : 'Uploads stay disabled until an R2 bucket is bound — the rest of the app works normally.';

    const setupRequired = !!data.setup_required;
    const lastError = $('#setup-last-error');
    if (data.setup_last_error && setupRequired) {
      lastError.classList.remove('hiddenish');
      lastError.innerHTML = `<strong>The previous setup attempt failed.</strong><br>${esc(data.setup_last_error)}`;
    } else {
      lastError.classList.add('hiddenish');
    }
    $('#form-block').classList.toggle('hiddenish', !setupRequired);
    $('#done-block').classList.toggle('hiddenish', setupRequired);

    const submit = $('#s-submit');
    if (submit) {
      submit.disabled = !databaseOk;
      if (!databaseOk) submit.textContent = 'Waiting for the database binding…';
    }
    if (setupRequired && databaseOk) submit.textContent = 'Create workspace & sign in';

    const banner = $('#s-error');
    if (!databaseOk && setupRequired) {
      banner.classList.remove('hiddenish');
      banner.textContent = data.database?.error || 'DexterOS cannot reach a database yet. Add the binding and re-check.';
    } else {
      banner.classList.add('hiddenish');
    }

    // Workspace counts are useful confirmation that the binding points at the right DB.
    if (databaseOk && data.initialized) {
      $('#storage-note').textContent = `${data.counts?.tenants ?? 0} workspace(s), ${data.counts?.users ?? 0} account(s), ${data.counts?.apps ?? 0} app(s) in this database.`;
    }
  }

  async function load() {
    try {
      render(await api.get('/api/system/status'));
    } catch (err) {
      $('#checks').innerHTML = `<p class="small" style="color:var(--danger)">${esc(err.message)}</p>`;
      $('#setup-steps').classList.remove('hiddenish');
    }
  }

  /* ------------------------------------------------------------- submission */
  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#s-error');
    error.classList.add('hiddenish');
    const button = $('#s-submit');
    const label = button.textContent;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Creating workspace…';
    try {
      const data = await api.post('/api/system/setup', {
        workspace_name: $('#s-workspace').value,
        name: $('#s-name').value,
        email: $('#s-email').value,
        password: $('#s-password').value,
      });
      store.token = data.token;
      toastOk(`Workspace "${data.tenant.name}" is ready.`);
      setTimeout(() => { location.href = '/admin'; }, 600);
    } catch (err) {
      error.classList.remove('hiddenish');
      error.innerHTML = esc(err.message)
        + (err.detail ? `<span class="tiny" style="display:block;margin-top:6px;opacity:.85">${esc(err.detail)}</span>` : '')
        + (err.reference ? `<span class="tiny" style="display:block;margin-top:4px;opacity:.7">Reference ${esc(err.reference)} (see the Functions log for the stack trace), or press “Run self-test”.</span>` : '');
      button.disabled = false;
      button.textContent = label;
      if (err.code === 'ALREADY_INITIALIZED') load();
    }
  });

  $('#recheck').addEventListener('click', async () => {
    toastOk('Re-checking the deployment…', 'Setup');
    await load();
  });

  /* -------------------------------------------------------------- self-test */
  function diagRow(check) {
    const ms = Number.isFinite(check.ms) ? `<span class="tiny muted"> · ${check.ms} ms</span>` : '';
    return `<div class="row" style="align-items:flex-start;gap:12px">
      <span style="font-size:18px">${check.ok ? '✅' : '⚠️'}</span>
      <div class="grow">
        <div class="row" style="gap:8px"><strong class="small">${esc(check.label)}</strong>${ms}</div>
        <div class="tiny muted" style="margin-top:2px">${esc(check.detail || '')}</div>
      </div>
    </div>`;
  }

  async function runDiagnostics() {
    const out = $('#diag-out');
    const button = $('#diag-run');
    button.disabled = true;
    out.innerHTML = '<span class="small muted">Running the checks…</span>';
    try {
      const res = await api.post('/api/system/diagnostics', {});
      out.innerHTML = `${res.checks.map(diagRow).join('')}
        <p class="tiny muted" style="margin-top:12px">${esc(res.summary || '')}</p>`;
      res.ok ? toastOk('Every check passed.') : toastErr('Some checks need attention — see the details above.');
      load();
    } catch (err) {
      out.innerHTML = `<p class="small" style="color:var(--danger)">${esc(err.message)}${err.detail ? ` — ${esc(err.detail)}` : ''}</p>`;
    } finally {
      button.disabled = false;
    }
  }

  $('#diag-run').addEventListener('click', runDiagnostics);

  load();
}());
