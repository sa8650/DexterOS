# DexterOS

A production multi-tenant SaaS workspace: every web app a team uses, arranged on one
Windows 11-inspired cloud desktop. Admins publish apps and wallpapers from a separate
console; members sign in and get a personal desktop with a multi-window workspace and an
un-removable Settings app.

**Runs entirely on Cloudflare:** Pages (hosting + Functions API), D1 (SQLite database) and
R2 (object storage). There is no local server, no local database and no demo data in this
repository — a deployment is initialised once, by you, through the first-run wizard.

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Deploy to Cloudflare Pages](#deploy-to-cloudflare-pages)
- [First run](#first-run)
- [Local development](#local-development)
- [Tests](#tests)
- [Configuration reference](#configuration-reference)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [API reference](#api-reference)

---

## Features

**Public landing page** — product story, feature grid, how-it-works, admin and workspace
previews, sign-in / register modals, fully responsive (desktop, tablet, mobile) and
deployment-aware: it advertises the setup wizard until the deployment is initialised, and
only offers self-service workspace creation when an administrator has enabled it.

**Cloud desktop (user console)**

- An auto-arranged grid of shortcuts, all rendered from the database: identical tile size,
  shape and spacing, name underneath every icon.
- Apps open **inside** the SaaS in DexerOS windows (iframe with a hardened sandbox), never
  in a new browser tab. The home screen stays visible underneath.
- Multi-window manager: movable, resizable, minimisable, maximisable, restorable and
  closable windows, plus drag-to-snap, taskbar buttons and keyboard shortcuts
  (`Esc`, `Alt+Tab`, `Alt+F4`, `Alt+Home`, `Ctrl+F5`).
- Sites that refuse framing (X-Frame-Options / CSP `frame-ancestors`) are detected up front
  and degrade gracefully into an explanatory card with pop-out, retry and copy-link options.
- Start menu with search, pinned and recently used apps, account flyout, clock and a
  one-click "Home" button that always brings the desktop back.
- **Settings** is a permanent, un-removable system app: profile, avatar, password,
  appearance, wallpaper picker, desktop preferences, sessions and account deletion.

**Admin console** (separate, hardened area for `admin`/`owner` roles)

- Applications: add, edit, delete, enable/disable, show/hide, pin, reorder, category,
  description, embed mode. Creating an app requires exactly **App Name + App Link + App
  Icon** (emoji, uploaded image or single letter, with colour).
- Wallpapers: upload images to R2 or add CSS gradients, edit name/details, mark a workspace
  default, enable/disable, delete; members only ever see active wallpapers.
- Members: list, search, filter by status and role, profile drawer (preferences, usage,
  sessions, activity), edit, promote/demote, suspend/activate, reset password, delete.
- Overview with live statistics, most-used apps, 14-day sign-up chart and an audit trail.
- Workspace settings (name, join code, join policy, member limit) and deployment settings.

**Platform**

- Multi-tenant by construction: every query is scoped to the caller's workspace, and
  cross-tenant access answers `404`.
- Registration modes: invites-only by default (the wizard creates the first workspace,
  admins invite members or share a join code), or open self-service workspaces.
- Storage in R2, delivered from your own domain at `/media/…`.
- Security headers, CSP, rate limiting, PBKDF2-SHA256 password hashing (capped at the
  runtime's supported maximum, see below) and opaque server-side sessions.

---

## Architecture

```
Browser
  │
  ├── static assets        → Cloudflare Pages            (public/)
  ├── /api/*               → Pages Functions router       (functions/api/[[path]].js → src/routes/*)
  └── /media/*             → Pages Function (R2 reader)   (functions/media/[[path]].js)

D1  (binding: DB)     tenants · users · apps · wallpapers · user_settings · sessions
                      app_usage · activity_log · embed_cache · app_settings · rate_limits · cloud_config
R2  (binding: MEDIA)  icons · wallpapers · avatars   → served at /media/<key>
```

- **Bindings are configured in the Cloudflare dashboard**, not in this repository. The code
  only refers to binding *names* (`env.DB`, `env.MEDIA`), and there is deliberately **no
  `wrangler.toml` / `wrangler.json` / `wrangler.jsonc` at the project root**: a root config
  file makes Cloudflare hide those fields in the dashboard (*"bindings of this project are
  managed through wrangler.toml"*). No account IDs, database IDs, bucket names or tokens are
  committed anywhere. See [Bindings live in the dashboard](#bindings-live-in-the-dashboard).
- The D1 schema is created **automatically** on the first API request. A `schema.sql` is
  included for manual/CI provisioning through the D1 console or `wrangler d1 execute`.
- **No Cloudflare credentials anywhere.** The app never asks for, stores or sends an API
  token, account id or database id. Cloudflare is reached exclusively through the `DB` and
  `MEDIA` bindings; removing the optional REST fallback also removed the last code path that
  could ever have handled a Cloudflare secret.

---

## Repository layout

```
public/                  static site served by Pages
  index.html             landing page
  setup.html             first-run wizard + deployment diagnostics
  app.html               cloud desktop (user console)
  admin.html             admin console
  404.html               branded not-found page
  _headers               security + cache headers (CSP, HSTS, no-store for HTML)
  _routes.json           only /api/* and /media/* are sent to Functions
  assets/css|js|img      design system, desktop shell, admin console, shared toolkit
functions/
  api/[[path]].js        API router (mounts src/routes/*)
  media/[[path]].js      serves uploaded files from R2
src/
  lib/                   db (D1/REST adapter), storage, auth, http, schema, settings, presenter, embed probe
  routes/                auth · me · portal · admin · system
schema.sql               D1 schema (optional manual provisioning)
tests/
  unit.test.js           API acceptance suite (219 checks) against the Pages runtime
  e2e.test.js            Puppeteer browser suite (91 checks) + screenshots
  helpers/server.js      boots `wrangler pages dev` with throwaway D1 + R2 stores
docs/wrangler.example.toml
                         reference only — a commented example of the optional config-file
                         route (never copy it to the project root)
```

---

## Deploy to Cloudflare Pages

### 1. Create the database and the bucket

In the Cloudflare dashboard:

1. **Workers & Pages → D1 → Create database** — e.g. `dexteros-db`.
2. **R2 → Create bucket** — e.g. `dexteros-media`.

Both are optional to *name*: bindings are what matters, and they are configured in the next
step. Nothing else about them is needed anywhere — no account id, no database id, no API
token. The names you pick are only visible in the dashboard.

### 2. Create the Pages project

Either connect this repository to a Pages project or deploy with the CLI.

**Git integration** — production branch `main` (or `master`), framework preset **None**,
build command `exit 0`, build output directory `public`. The `functions/` directory stays at
the repository root, next to `public/` — that is where Pages looks for it, it must never sit
inside the build output directory.

**CLI**

```bash
npm install
npx wrangler login
npm run deploy           # npx wrangler pages deploy public --project-name dexteros
```

With no config file in the repository, the project name has to be passed on the command line:
edit the `deploy` script (or add `--project-name <name>`) if your Pages project is not called
`dexteros`. Everything else — bindings, compatibility flags, variables — lives in the
dashboard, exactly as described below.

### 3. Add the bindings (dashboard only)

**Workers & Pages → your Pages project → Settings → Functions → Bindings**

| Type | Variable name | Value |
| --- | --- | --- |
| D1 database | `DB` | the database you created |
| R2 bucket | `MEDIA` | the bucket you created |

Redeploy (or trigger a new build) so the bindings reach the Worker. The front-end never sees
these names — only the server-side Functions do. `wrangler pages dev` is not needed for the
production bindings, and never commit a config file to create them.

### 4. Bindings live in the dashboard

DexterOS ships **no `wrangler.toml`, `wrangler.json` or `wrangler.jsonc`**. That is on
purpose: as soon as a Pages project contains a root Wrangler configuration file, Cloudflare
treats the file as the source of truth and the dashboard shows every binding as read-only
with the message *"bindings of this project are managed through wrangler.toml"*. Keeping the
repository config-free means:

- D1 and R2 bindings are added, edited and removed entirely from the dashboard
  (**Settings → Functions → Bindings**), for Production and Preview independently;
- compatibility flags live in **Settings → Functions → Compatibility flags**;
- environment variables and secrets live in the same settings page — the app reads them
  through `env`, so nothing has to be templated into a file.

If the dashboard is *already* showing the read-only message (because an earlier deployment
shipped a root config file):

1. Delete `wrangler.toml` / `wrangler.json` / `wrangler.jsonc` from the repository root and
   commit — the file in `docs/wrangler.example.toml` is documentation only and is ignored by
   Cloudflare.
2. Trigger a **new deployment** (push, or `npm run deploy`). The values from your last
   deployment keep applying, and after that build the settings become editable again.
3. In the unlikely case that **Build** settings stay locked too, create a new Pages project
   from the same repository with the settings above — a two-minute operation that removes the
   stale configuration for good.

Prefer the config-file workflow? That is possible, but it is all-or-nothing: once the file is
committed, bindings can only be changed by editing and re-deploying it. The commented example
that does exactly that lives in `docs/wrangler.example.toml`.

### 5. Optional environment variables

Environment **variables** and **secrets** live in the same settings page. All are optional;
see the [configuration reference](#configuration-reference).

### 6. Optional: pre-create the schema

Not required (the app creates it on first request). To provision it yourself, paste
`schema.sql` into the D1 console, or run

```bash
npx wrangler d1 execute DB --remote --file=./schema.sql   # pass a database id if the name is ambiguous
```

The D1 commands take the database as an argument, so no config file is involved — and none
should be added just for this.

---

## First run

1. Open `https://<your-project>.pages.dev/setup`.
2. The wizard reports both wiring checks (`D1 database`, `R2 storage`). If a binding is
   missing, the page tells you exactly which one to add — and where. Press **Run self-test**
   for a full report (database binding, schema, database writes, password hashing and the
   media bucket, each with its own result and timing).
3. Create the first workspace and its owner account. Setup can only run while the deployment
   has no accounts; afterwards it is locked.
4. You land in the admin console: publish apps, upload wallpapers, invite members.
5. Members sign in at `/` and land on `/app`; administrators land on `/admin`.

Registration is **closed** by default. Choose one of:

- **Invite** — Admin console → Members → *Add member* (creates the account with a temporary
  password you share securely), or
- **Join code** — share the workspace join code so teammates can register themselves, or
- **Open** — Admin console → Workspace → Deployment settings → *Allow new workspaces* if you
  want anyone to be able to create their own isolated workspace.

---

## Local development

```bash
npm install                 # wrangler + puppeteer
npm run dev                 # wrangler pages dev public --d1 DB --r2 MEDIA --compatibility-date=2025-07-18 --persist-to .wrangler/state --port 8788
```

Because the repository has no config file, the local bindings are passed as CLI flags — this
simulates `DB` and `MEDIA` locally and has no effect on the deployed project.

Open <http://localhost:8788/setup> (the CLI flags create local, simulated D1 and R2
resources, so the whole product runs offline). Local state lives in `.wrangler/state` and is
git-ignored.

> The installed Wrangler (3.x) may warn that the requested `compatibility_date` is newer than
> the bundled runtime and fall back to an earlier date — harmless for local development;
> production uses the real Cloudflare runtime. Upgrading to `wrangler@4` removes the warning.

---

## Tests

```bash
npm test              # API suite, then browser suite
npm run test:unit     # 219 checks: deployment config, setup, diagnostics, auth, tenancy, CRUD, uploads, security, rate limits
npm run test:e2e      # 91 checks: real UI in headless Chrome + screenshots in tests/screens/
```

Both suites boot the **real Pages runtime** (`wrangler pages dev`) with throwaway D1/R2
stores, so they never touch your production data. The browser suite needs Chromium and the
usual system libraries:

```bash
sudo apt-get install -y libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2t64 fonts-liberation fonts-noto-color-emoji
```

---

## Configuration reference

Set these in **Pages → Settings → Environment variables** (Production and/or Preview). None
are required for a working deployment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_NAME` | `DexterOS` | Product name shown in the UI for a brand-new deployment. |
| `REGISTRATION_MODE` | `closed` | `open` allows anyone to create a new workspace from the landing page. |
| `MAX_USERS_PER_TENANT` | `50` | Member limit applied to newly created workspaces. |
| `MAX_TENANTS` | `50` | Maximum number of workspaces on this deployment. |
| `UPLOAD_MAX_BYTES` | `6291456` | Maximum upload size for icons, wallpapers and avatars. |
| `PBKDF2_ITERATIONS` | `100000` | Password-hash cost, clamped to 10 000–100 000 (the Workers runtime refuses more). |
| `R2_PUBLIC_BASE_URL` | — | Use a bucket custom domain instead of `/media/…` for stored files. |
| `SUPPORT_EMAIL` | — | Contact address shown in the console. |
| `SETUP_KEY` (secret) | — | Keeps the diagnostics endpoints usable after setup (send as `x-setup-key`). |

Deployment settings that belong to the *product* (registration mode, service name, limits,
embed-probe toggle) are stored in D1 and editable in **Admin console → Workspace →
Deployment settings**, so you rarely need to touch Cloudflare for them.

---

## Security model

- **Passwords** — PBKDF2-HMAC-SHA256, per-user salt, constant-time verification, minimum 10
  characters with a letter and a digit, common passwords rejected. The iteration count is
  capped at **100 000**, the highest value the Cloudflare Workers runtime accepts: anything
  higher makes `crypto.subtle` throw `NotSupportedError`, which would break registration,
  sign-in and first-run setup. If a runtime ever refuses the configured count, hashing steps
  down automatically instead of failing, and the count actually used is stored inside each
  hash (`pbkdf2$<iterations>$<salt>$<hash>`) so verification always applies the right one.
  Set `PBKDF2_ITERATIONS` to tune it (10 000–100 000).
- **Sessions** — 256-bit opaque tokens stored hashed-by-possession in D1, delivered as an
  `HttpOnly; SameSite=Lax; Secure` cookie and/or `Authorization: Bearer`. Suspending a member
  destroys their sessions immediately.
- **Authorisation** — every route declares `none | optional | user | admin`; `/api/admin/*`
  requires `admin`/`owner`; every query is scoped by `tenant_id`; cross-tenant IDs return 404.
- **Protections** — the last active administrator cannot be suspended, demoted or deleted;
  administrators cannot delete or demote themselves; the Settings app cannot be deleted,
  disabled or hidden; system rows are protected server-side, not just in the UI.
- **Input handling** — only `http(s)` links are accepted for apps, images must be a real
  image type and size, all SQL is parameterised, and every response is JSON-encoded and
  escaped at render time (no inline handlers, so a strict CSP holds).
- **Headers** — `public/_headers` sets CSP (`frame-ancestors 'self'`, `frame-src *` for the
  desktop only), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
  `Cache-Control: no-store` for HTML.
- **Rate limiting** — D1-backed counters for sign-in, registration, setup and workspace
  lookups survive across Worker isolates (an in-memory limiter would not).
- **Error reporting** — server errors return a short reference plus a generic message.
  Technical detail is added only while the deployment has no accounts yet (the person
  reading it is the operator running setup) or when the caller presents the `SETUP_KEY`
  secret; a live deployment never exposes internals.
- **No Cloudflare credentials** — the code contains no API-token path at all: storage and
  database access happen through the `DB`/`MEDIA` bindings. The only authentication in the
  product is the app's own register/login with PBKDF2-SHA256 hashing.
- **Audit trail** — sign-ins, profile and password changes, app/wallpaper/member/settings
  changes and account deletions are recorded per workspace.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Pages dashboard says *bindings of this project are managed through wrangler.toml* | A root config file exists in the deployment. Delete it, push, and create a new deployment — see [Bindings live in the dashboard](#bindings-live-in-the-dashboard). |
| `/setup` says *DexterOS is not connected to a database yet* | Add the D1 binding named `DB` in **Pages → Settings → Functions → D1 database bindings**, then redeploy. |
| Uploads fail with *Storage is not connected* | Add the R2 binding named `MEDIA` in **Pages → Settings → Functions → R2 bucket bindings**, then redeploy. |
| `DB_NOT_CONFIGURED` in the API | Same as above — the database is reached through the `DB` binding only. |
| *Something went wrong on our side* during setup | The wizard now shows the failing step, the technical cause and a reference. Press **Run self-test** on `/setup`, or `POST /api/system/diagnostics`, to see which step fails (database, schema, writes, password hashing, storage). A previously failed attempt is also remembered and shown at the top of the form. |
| Sign-in or setup fails on a Workers **Free** plan | The free plan allows 10 ms of CPU per request, which PBKDF2 password hashing can exceed (≈23 ms at 100 000 iterations). Upgrade the Worker to a paid plan, or lower `PBKDF2_ITERATIONS` deliberately. The self-test reports how long hashing took on your deployment. |
| Setup says *already been set up* | A workspace exists. Sign in, or reset the database and reload `/setup`. |
| An app shows *can't be displayed inside a DexterOS window* | The site sends `X-Frame-Options`/`frame-ancestors` — a browser security policy no launcher can override. Use the pop-out, or set the app's embed mode to *Inline (force)* if you know it renders in frames. |
| Password reset for a member needed | Admin console → Members → 🔑 (their sessions are revoked; they sign in with the new password). |
| Local dev shows a compatibility-date warning | Cosmetic for Wrangler 3 — see [Local development](#local-development). |

Need the diagnostics after setup? Set the `SETUP_KEY` secret and send it as an `x-setup-key`
header to `POST /api/system/schema` and `POST /api/system/diagnostics`. Before the first
workspace exists both are open, because at that point there is nothing to protect.

---

## API reference

All responses are JSON. Authentication is by session cookie or `Authorization: Bearer <token>`.

### System (no session required)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/system/health` | Liveness probe; works even with no bindings. |
| `GET` | `/api/system/status` | Wiring checks, setup state, counts, registration mode. |
| `POST` | `/api/system/schema` | Creates the schema (idempotent; `x-setup-key` once set up). |
| `POST` | `/api/system/setup` | One-time first-run: workspace + owner + starter content. Reports the exact step and cause if it fails. |
| `POST` | `/api/system/diagnostics` | Step-by-step self-test of the deployment: binding, schema, writes, password hashing, storage. Open before setup; needs `x-setup-key` afterwards. |

### Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{ mode: "create" \| "join", … }` — subject to deployment policy. |
| `POST` | `/api/auth/login` | `{ email, password, workspace? }`. |
| `POST` | `/api/auth/logout` | Clears the session cookie/server session. |
| `GET` | `/api/auth/session` | Current user, workspace, settings and wallpaper. |
| `GET` | `/api/auth/workspace/:code` | Public join-code lookup (name, members, joinable). |

### Me

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/me` | Profile + preferences. |
| `PATCH` | `/api/me` | Name, email, title, phone, avatar (`letter`/`emoji`/`image`). |
| `POST` | `/api/me/avatar` | `multipart/form-data`, field `file` → stored in R2. |
| `PATCH` | `/api/me/password` | `{ current_password, new_password }`. |
| `PATCH` | `/api/me/preferences` | `wallpaper_id`, `accent`, `theme`, `taskbar_align`, `icon_size`, `show_labels`, `reduced_transparency`. |
| `POST` | `/api/me/sessions/revoke` | Signs out every device. |
| `DELETE` | `/api/me` | `{ password }` — deletes the account. |

### Portal (user console)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/portal/bootstrap` | One request that boots the whole desktop. |
| `GET` | `/api/portal/apps` | Visible + enabled apps for the workspace. |
| `POST` | `/api/portal/apps/:id/launch` | Usage tracking for a launch. |
| `GET` | `/api/portal/wallpapers` | Active wallpapers + the caller's current one. |
| `GET` | `/api/portal/embed-check?url=…` | Frame-embedding verdict (workspace apps only) with `recheck=1` to force. |
| `GET` | `/api/portal/stats` | Personal usage statistics. |

### Admin (`admin`/`owner` only)

| Method | Path |
| --- | --- |
| `GET` | `/api/admin/overview` · `/api/admin/activity` · `/api/admin/settings` |
| `GET POST` | `/api/admin/apps` |
| `PATCH DELETE` | `/api/admin/apps/:id` |
| `POST` | `/api/admin/uploads/icon` |
| `GET POST` | `/api/admin/wallpapers` |
| `PATCH DELETE` | `/api/admin/wallpapers/:id` |
| `POST` | `/api/admin/wallpapers/upload` |
| `GET POST` | `/api/admin/users` |
| `GET PATCH DELETE` | `/api/admin/users/:id` |
| `POST` | `/api/admin/users/:id/reset-password` |
| `PATCH` | `/api/admin/workspace` · `/api/admin/settings` |

---

DexterOS is a self-contained Cloudflare Pages application: no external services, no
telemetry, and no third-party runtime dependencies beyond Cloudflare itself.
