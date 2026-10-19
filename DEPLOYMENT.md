# Newtonite Ops deployment guide

## Deployment target and scope

Newtonite Ops is a **Node.js 22 / Express TypeScript API**, a **React/Vite static frontend**, a PostgreSQL database, and a continuously running PostgreSQL outbox worker. It is not a FastAPI application. Render supports each required service type:

1. Render PostgreSQL (managed database)
2. Render Web Service (Express API)
3. Render Static Site (Vite frontend)
4. Render Background Worker (outbox processing)

The instructions below configure services but do not create them. No deployment, paid resource, or repository push has been performed.

The current downloaded workspace has no Git metadata. Render's Git-based deployment requires a repository connected to Render. Before deployment, place the reviewed project in a private Git repository using your own approved process. Do not include `.env`, local database files, generated secrets, or credentials.

## Latest local verification

Verified on 2026-10-19 in the current Windows workspace:

- API tests: **58/58 passed** against an isolated disposable PostgreSQL test database.
- Frontend tests: **19/19 passed** against a separate disposable PostgreSQL test database and the real API.
- Fresh-database migrations: **001_init.sql**, **002_auth_hardening.sql**, and **003_activity_append_only.sql** applied successfully.
- API and frontend type checks passed. Lint completed with **0 errors and 16 existing `any` warnings**.
- Production frontend build passed with an explicit HTTPS API origin; it rejects missing API configuration and the generated bundle contains no localhost API fallback.
- The HTTP E2E script passed against a running local API and a fresh seeded disposable PostgreSQL database. A real browser session against the local Vite frontend/API verified login, dashboard, search, status filter, pagination, create, claim, assignment, workflow approval, authorization controls, and activity history.
- Earlier full browser suite (111 Chromium checks), Docker image builds, Compose validation, and isolated Compose runtime checks passed in prior verification. The full 111-check suite and Docker/Compose checks were not repeated in this run.

These are local test results, not evidence of a Render deployment. No live services or endpoints have been verified.

## Production readiness gates

- Use a new, dedicated production database. Never point production at a development/test database.
- Do not run `npm run seed` in production. The seed script truncates application data and creates public demo accounts with a shared, known password.
- The application currently has **no user registration or administrator/user provisioning endpoint**. Arrange and review a secure first-admin provisioning procedure before go-live. Do not use the demo seed as that procedure.
- Use a production-generated JWT secret and the exact HTTPS frontend origin in the API CORS allowlist.
- Production smoke tests that require login cannot pass until a real first user/team has been provisioned.
- Deploy to staging first, and verify database backups/restore procedures before loading production data.

## Create services in this order

Use the same Render region for the API, worker, and PostgreSQL database. Choose final service names before configuring origins so their generated `onrender.com` URLs are known. For a custom frontend domain, use that HTTPS origin instead.

### 1. Managed PostgreSQL

Create a Render PostgreSQL database:

- PostgreSQL major version: **16** (matches the local/test version).
- Region: same as the API and worker.
- Database: dedicated production database; retain Render's generated credentials.
- Select a persistent plan with backups/retention appropriate to the data and availability requirements. Do not rely on an expiring or disposable database for live data.
- Restrict external database access in the Render Networking settings (disable it if operationally possible, or allowlist only required operator IPs). The API and worker use the **Internal Database URL** from the same region; do not use the external URL for either service.
- The `pg` connection parser must be told to use Render's documented libpq-compatible `sslmode=require` behavior for its self-signed internal TLS certificate. In the API and worker `DATABASE_URL`, append `?uselibpqcompat=true&sslmode=require` (or `&...` if the URL already has query parameters). This requires TLS but does not validate the self-signed certificate; keep the database on Render's private network and never use this URL mode for an untrusted public endpoint.
- The application creates a PostgreSQL pool with a maximum of 20 connections **per process**. Account for the API and worker pools, and any additional API instances, when selecting the database plan and scaling services.

Do not copy connection credentials into source files, logs, tickets, or this guide.

### 2. API Web Service

Create a Render **Web Service** connected to the repository:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root Directory | Repository root (blank) |
| Node version | `>=22 <23` from the root `package.json` |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm run migrate && npm start` |
| Health Check Path | `/health` |

Set these API environment variables in the Render dashboard:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Render PostgreSQL **Internal Database URL** |
| `JWT_SECRET` | Secret generated for production with at least 32 characters; use 32 random bytes encoded as 64 hex characters |
| `CORS_ORIGINS` | Exact HTTPS origin of the frontend, e.g. `https://<your-static-site>.onrender.com`; add a comma-separated custom frontend origin only if it is also required |
| `TRUST_PROXY` | `1` for Render's single trusted proxy hop, so client-IP login throttling sees the forwarded client address |

Render provides `PORT`; do not hardcode a production port. The API listens on that value. Do not set a wildcard CORS origin or a localhost origin in production. The service refuses to start if the production CORS allowlist is missing, non-HTTPS, or contains paths instead of origins.

The `/health` endpoint executes `SELECT 1`; Render should mark the instance unhealthy if PostgreSQL is unavailable.

### 3. Static frontend

Create a Render **Static Site** from the same repository:

| Setting | Value |
|---|---|
| Root Directory | Repository root (blank); the build imports shared types from `../shared` |
| Node version | `>=22 <23` from the root `package.json` |
| Build Command | `npm ci --prefix web --include=dev && npm --prefix web run build` |
| Publish Directory | `web/dist` |

Set this build-time environment variable on the Static Site:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | API HTTPS origin only, e.g. `https://<your-api-service>.onrender.com` (no path and no trailing slash) |

`VITE_API_BASE_URL` is embedded in the public frontend bundle; it is **not a secret**. Production builds now fail rather than silently compiling a localhost API URL if it is missing or malformed. Rebuild the Static Site whenever this URL changes.

After Render gives the Static Site its final URL, ensure the API's `CORS_ORIGINS` is exactly that origin. If the API was initially configured with a planned URL, correct it in the dashboard and redeploy the API before smoke testing. Add a custom domain to the allowlist only after the domain is configured with HTTPS.

### 4. Outbox background worker

Create a Render **Background Worker** from the same repository:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root Directory | Repository root (blank) |
| Node version | `>=22 <23` from the root `package.json` |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm run worker` |

Set `NODE_ENV=production` and the same production `DATABASE_URL` as the API. The worker does not serve HTTP and does not need `PORT`, `JWT_SECRET`, or `CORS_ORIGINS`. Deploy it after the API has successfully applied migrations. It claims outbox jobs from PostgreSQL, retries eligible failures, and records permanently failed jobs in `outbox_jobs`; monitor its Render logs and that table.

## Database migrations and releases

The API start command runs `npm run migrate` before `npm start`. The migration runner applies ordered SQL migrations once, records them in `schema_migrations`, takes a PostgreSQL advisory lock, and rolls back a failing migration transaction. Current migration files are:

- `001_init.sql`
- `002_auth_hardening.sql`
- `003_activity_append_only.sql`

For each release:

1. Take/confirm a recoverable database backup before schema changes.
2. Test the same release against a separate staging database first.
3. Review new SQL for compatibility with the previous running application version; use expand/contract migrations for zero-downtime changes.
4. Deploy the API and verify migration logs plus `/health`.
5. Deploy the worker and frontend after API compatibility is confirmed.
6. Never drop schemas, reset production data, or run the demo seed as a migration step.

The migration lock prevents concurrent migration runs but does not replace backups or backward-compatible migration design.

## Local validation before deployment

Run from PowerShell at the repository root. API and web test suites reset/seed their target test databases; only use separately created, disposable databases whose names end in `_test` or `-test`.

```powershell
npm ci
npm --prefix web ci
npm run typecheck
npm run lint
$env:DATABASE_URL = '<connection-string-for-a-dedicated-api-test-database-ending-in-_test>'
npm test
$env:WEB_TEST_DATABASE_URL = '<different-connection-string-for-a-dedicated-web-test-database-ending-in-_test>'
npm --prefix web test
$env:VITE_API_BASE_URL = 'https://api.example.invalid'
npm --prefix web run build
Remove-Item Env:DATABASE_URL, Env:WEB_TEST_DATABASE_URL, Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
```

Do not use production or development database URLs for these tests.

## Manual deployment checklist

- [ ] Put the reviewed workspace in a private Git repository through your approved workflow; verify `.env` and credentials are excluded.
- [ ] Create production PostgreSQL 16 in the same region as the services; choose persistent storage and suitable backup/retention.
- [ ] Create the API Web Service with the commands and environment above; generate/store `JWT_SECRET` only in Render's secret environment UI.
- [ ] Create the Static Site with `VITE_API_BASE_URL` set to the API's HTTPS origin and the repository root as its build context.
- [ ] Set the API `CORS_ORIGINS` to the final Static Site HTTPS origin (and only required custom origins); redeploy the API if changed.
- [ ] Confirm API startup logs show the intended migrations applied or already current; confirm `/health` returns HTTP 200 and `{"ok":true}`.
- [ ] Provision the first real administrator and team using a separately reviewed, non-destructive process. Do not seed demo accounts in production.
- [ ] Create the Background Worker with the production database URL; confirm it remains running and processes a test outbox job.
- [ ] Verify database backup/restore, monitoring/alerts, and a rollback/release procedure before accepting real work.

## Live smoke tests

Replace the placeholders only in your local terminal; do not paste secret values into logs or reports.

```powershell
$api = 'https://<your-api-service>.onrender.com'
$frontend = 'https://<your-static-site>.onrender.com'
Invoke-RestMethod "$api/health"
Invoke-WebRequest $frontend -Method Get
```

After a real first user is provisioned:

1. Open `$frontend` and check browser developer tools: API requests use the deployed HTTPS API origin, not localhost; no CORS or CSP errors appear.
2. Sign in with the separately provisioned account; verify `/api/v1/auth/me`, dashboard, and team-scoped item listing.
3. Create, edit, assign/claim, and transition an item; verify a second authorized user sees the changes and activity history.
4. Verify a user outside the item's team gets the expected authorization response; verify stale edits return `409`.
5. Generate an outbox event and confirm the worker processes it; inspect Render worker logs and the resulting database notification/job status.
6. Sign out, verify a protected route requires authentication, and verify the exact frontend origin is allowed while an unlisted origin receives no `Access-Control-Allow-Origin` header.
7. Confirm the database backup is restorable in a separate non-production target.

Do not call the app live until the services are deployed and these endpoint and user-journey checks actually pass.

## Render references

- [Node/Express Web Services](https://render.com/docs/web-services)
- [Static Sites](https://render.com/docs/static-sites)
- [Background Workers](https://render.com/docs/background-workers)
- [Render PostgreSQL connections](https://render.com/docs/postgresql-creating-connecting)
- [Health Checks](https://render.com/docs/health-checks)
- [Language versions](https://render.com/docs/language-support)
