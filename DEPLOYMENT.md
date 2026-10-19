# Deployment guide (Render)

This guide configures deployment but does not create services or claim that Newtonite Ops is live. Render is compatible with the current architecture: managed PostgreSQL, FastAPI web service, static Vite frontend, and a separate background worker. Do not deploy until the current local test results and diff have been reviewed.

## Services

Create the PostgreSQL database first, then the API, static site, and worker. Use PostgreSQL 16 and the same Render region for the database, API, and worker. Use a persistent database plan with backups appropriate to the data. The API and worker should use Render's private/internal database connection string.

### 1. FastAPI API Web Service

| Render setting | Value |
|---|---|
| Runtime | Python 3 |
| Root Directory | `backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/health` |

Set these variables in the Render service's environment settings:

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `DATABASE_URL` | Internal URL for the dedicated production PostgreSQL database |
| `SESSION_SECRET` | Unique random secret, at least 32 characters; generate with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and store only in Render's secret environment settings |
| `CORS_ORIGINS` | Exact HTTPS origin of the deployed frontend, without a path or trailing slash |
| `COOKIE_SECURE` | `true` |
| `LOGIN_MAX_FAILURES` | `10` (or an explicitly reviewed policy value) |
| `SESSION_TTL_MINUTES` | `15` |
| `PORT` | Supplied by Render; do not hardcode |

The API normalizes common `postgres://` and `postgresql://` URLs to the psycopg SQLAlchemy driver. Production startup rejects a short/missing session secret, non-HTTPS or wildcard CORS origins, and insecure cookies. The CORS policy permits credentials only from the configured exact origins. Do not include localhost or a wildcard in the production list.

The start command applies Alembic migrations before starting Uvicorn. Migrations use a PostgreSQL advisory lock, but they are not a substitute for a verified backup. Back up the database and test changes in staging before a production release. Never reset, drop, or seed production data.

### 2. React/Vite Static Site

| Render setting | Value |
|---|---|
| Runtime | Static Site |
| Root Directory | `frontend` |
| Build Command | `npm ci && npm run build` |
| Publish Directory | `dist` |

Set the build-time variable:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | API HTTPS origin only, e.g. `https://<api-service>.onrender.com`; no `/api/v1` suffix, path, credentials, or trailing slash |

The production Vite build fails if this URL is missing or not an HTTPS origin. It is public configuration embedded in the JavaScript bundle, not a secret. Rebuild the static site after changing it.

Add a Render rewrite rule for the React router:

| Source | Destination | Action |
|---|---|---|
| `/*` | `/index.html` | Rewrite |

Configure static response security headers if supported by the selected host. The built `index.html` includes a CSP meta policy restricting connections to the configured API; a response header can additionally set `frame-ancestors 'none'`. For example, include `connect-src 'self' https://<api-service>.onrender.com` and `frame-ancestors 'none'` in the host's CSP header. Do not configure a second restrictive CSP that omits the API origin.

### 3. PostgreSQL outbox worker

| Render setting | Value |
|---|---|
| Runtime | Background Worker, Python |
| Root Directory | `backend` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `python -m app.worker.main` |

Configure the worker with the same `APP_ENV`, `DATABASE_URL`, and `SESSION_SECRET` as the API. `CORS_ORIGINS` and `COOKIE_SECURE` may also be supplied from the API environment; the app settings validate production configuration when the worker loads. The worker does not expose an HTTP health endpoint.

The worker leases outbox rows with `FOR UPDATE SKIP LOCKED` and writes idempotent notification rows in PostgreSQL. It does not send email, SMS, or push messages. Confirm that the process remains running and that a generated job reaches `DONE` before relying on background processing.

### 4. Provision the first production account

There is no public sign-up or user-administration API. After the API migration succeeds, use Render's API Shell or another secure operator shell, with the production environment attached, to create the first team and admin:

```powershell
python -m app.provision_user --team-name "Operations" --team-slug operations --name "Initial Admin" --email admin@example.com --role ADMIN
```

The command prompts for a password twice without echoing it, requires at least 16 characters, creates the team only if that slug is absent, refuses to overwrite an existing user, and writes the password hash. Confirm the selected database is the intended production database before running it. Use the same command with an existing team slug and a chosen role to add additional team members.

Do not use `python -m app.seed` in production. It is development-only and contains shared demo credentials.

## Release and migration procedure

1. Review the code and migration revisions. Take or confirm a restorable backup.
2. Apply the release to a staging database first and verify the current API and worker.
3. Confirm the API's `DATABASE_URL` references the intended production database; do not log or paste its value.
4. Deploy the API. Check startup logs for migration completion and the service health state.
5. Deploy the static site with the API HTTPS origin. Set the API `CORS_ORIGINS` to the final static-site HTTPS origin and redeploy the API if required.
6. Deploy the worker. Confirm it remains active and processes a smoke-test outbox row.
7. Provision the first administrator using the interactive command above.
8. Run the live smoke tests below and verify database backup/restore separately before accepting real work.

Alembic supports fresh databases and a recognized legacy schema adoption path. It rejects unknown or partial schemas instead of dropping/recreating them. If production contains an existing database, review its schema and migration logs before proceeding; stop on an adoption error and investigate rather than resetting it.

## Local Windows validation

The following commands use the local Compose PostgreSQL instance, loopback port `5433`, and databases explicitly named for testing. First create the local `.env` from `.env.example`, replace its session secret with a generated local-only value, and start the database:

```powershell
Copy-Item .env.example .env
docker compose up -d db
docker compose exec db psql -U newtonite -d postgres -c "CREATE DATABASE newtonite_api_eval_test;"
docker compose exec db psql -U newtonite -d postgres -c "CREATE DATABASE newtonite_frontend_eval_test;"
```

Do not drop or reset an existing database to rerun tests; choose another fresh database name ending in `_test`.

Install Python dependencies and run backend tests and lint:

```powershell
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
$env:DATABASE_URL = "postgresql+psycopg://newtonite:local_dev_only@127.0.0.1:5433/newtonite_api_eval_test"
Push-Location backend
..\backend\.venv\Scripts\python.exe -m pytest app\tests -q
..\backend\.venv\Scripts\ruff.exe check app
Pop-Location
```

Run frontend integration tests (which start a real FastAPI process) and quality checks:

```powershell
$env:FRONTEND_TEST_DATABASE_URL = "postgresql+psycopg://newtonite:local_dev_only@127.0.0.1:5433/newtonite_frontend_eval_test"
$env:PYTHON = (Resolve-Path backend\.venv\Scripts\python.exe).Path
npm --prefix frontend ci
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run lint
$env:VITE_API_BASE_URL = "https://api.example.invalid"
npm --prefix frontend run build
Remove-Item Env:DATABASE_URL, Env:FRONTEND_TEST_DATABASE_URL, Env:PYTHON, Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
```

The frontend integration setup runs Alembic and additive demo seeding on its dedicated frontend test database. It requires a fresh isolated database for a reproducible clean run. `DATABASE_URL` and `FRONTEND_TEST_DATABASE_URL` must not identify the same database. These suites must never target a production or valuable development database.

Validate Compose syntax and local service behavior without deleting its database volume:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:8000/health
Invoke-WebRequest http://localhost:5173 -Method Get
```

To seed disposable local demo data only:

```powershell
docker compose exec api python -m app.seed
```

To stop services without removing persistent database data:

```powershell
docker compose down
```

Do not add `-v` to `docker compose down`.

## Live smoke-test checklist

After deployment and real account provisioning, run checks from an operator machine:

```powershell
$api = "https://<api-service>.onrender.com"
$frontend = "https://<static-site>.onrender.com"
Invoke-RestMethod "$api/health"
Invoke-WebRequest $frontend -Method Get
```

Then, using the browser and a non-demo account:

1. Sign in and confirm dashboard and work-item requests reach the deployed HTTPS API.
2. Search and filter team records; confirm pagination loads a later page.
3. Create a work item, edit it, assign/claim it, add a comment, and inspect activity history.
4. Verify member/lead restrictions and cross-team isolation using accounts with known roles.
5. Open the same version in two sessions and verify one stale edit receives `409 STALE_VERSION`.
6. Retry item creation with the same idempotency key and confirm the same item is returned once.
7. Sign out, then verify a protected route redirects to sign-in.
8. Confirm the frontend origin is allowed by CORS and an unrelated origin is not.
9. Generate an outbox event and confirm the worker records its notification and marks the job complete.
10. Verify backup and restore in a separate non-production database.

Do not describe the application as live or deployment-ready until the actual service URLs, user journey, worker, and database behavior have been checked. Do not deploy, create paid resources, push changes, or alter repository visibility as part of local validation.
