# Newtonite Ops

Newtonite Ops is a team-scoped operations work queue with a React/TypeScript frontend and a FastAPI/PostgreSQL backend. It supports secure cookie sessions, role-aware workflows, append-only activity history, optimistic updates, idempotent work-item creation, and a transactional outbox worker.

## Features

- Dashboard summaries, team-scoped search, filtering, and cursor-based pagination.
- Work-item creation, edits, assignment/claiming, comments, and controlled status/approval transitions.
- Team roles (`VIEWER`, `MEMBER`, `LEAD`, `ADMIN`) enforced by the API on every protected operation.
- HttpOnly session cookies with CSRF checks for state-changing requests.
- Version-based conflict detection, idempotency keys, transactional activity history, and an asynchronous outbox.
- Responsive React interface with an accessible list and detail views.

See [ARCHITECTURE.md](./ARCHITECTURE.md), [DESIGN.md](./DESIGN.md), and [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) for implementation details and scope.

## Requirements

- Docker Desktop with Docker Compose v2 for the simplest Windows setup; or Python 3.11+, PostgreSQL 16, and Node.js 22 for running services separately.
- PowerShell commands below are intended for Windows.

## Start the full local application (Docker Compose)

From the repository root:

```powershell
Copy-Item .env.example .env
```

Open `.env` and replace `SESSION_SECRET` with a random local value. Generate one without printing it in a shared log:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Then start services and (optionally) add local demo data:

```powershell
docker compose up --build -d
docker compose ps
docker compose exec api python -m app.seed
Invoke-RestMethod http://localhost:8000/health
Start-Process http://localhost:5173
```

The API applies Alembic migrations before serving traffic. The database uses the named `pgdata` volume; preserve it when restarting. Do not delete the volume to troubleshoot credentials or schema state. If the database password in `.env` is changed after PostgreSQL initialized its volume, changing the environment variable alone does not update the database role password.

The demo seed only runs when `APP_ENV=development`; it is additive and never clears existing data. Its shared demo password is `demo-local-only`. Do not use seeded accounts or demo data in a real deployment.

## Run components without Docker

Create a virtual environment and install backend requirements:

```powershell
py -3.11 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
Copy-Item backend\.env.example backend\.env
```

Edit `backend\.env` for the local PostgreSQL URL and a random `SESSION_SECRET`, then run the API in one PowerShell window:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m app.seed
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In another PowerShell window:

```powershell
Set-Location frontend
npm ci
npm run dev
```

The frontend development default is `http://localhost:8000`. Set `VITE_API_BASE_URL` in `frontend/.env.local` only when the API uses a different local origin. Do not set `VITE_API_BASE_URL` to a URL containing credentials or secrets.

## Tests and quality checks

Backend tests use real PostgreSQL and refuse to run unless `DATABASE_URL` names a dedicated database ending in `_test` or `-test`. Frontend integration tests launch the real FastAPI service and seed the explicitly configured `FRONTEND_TEST_DATABASE_URL`; use a separate fresh test database. Never set these variables to a production or valuable development database.

After starting Compose, create each isolated test database once (do not drop an existing database):

```powershell
docker compose exec db psql -U newtonite -d postgres -c "CREATE DATABASE newtonite_api_test;"
docker compose exec db psql -U newtonite -d postgres -c "CREATE DATABASE newtonite_frontend_test;"
```

Backend suite:

```powershell
$env:DATABASE_URL = "postgresql+psycopg://newtonite:local_dev_only@127.0.0.1:5433/newtonite_api_test"
Set-Location backend
..\backend\.venv\Scripts\python.exe -m pytest app\tests -q
..\backend\.venv\Scripts\ruff.exe check app
Remove-Item Env:DATABASE_URL
Set-Location ..
```

Frontend suite (the integration setup starts a test API on port 3200):

```powershell
$env:DATABASE_URL = "postgresql+psycopg://newtonite:local_dev_only@127.0.0.1:5433/newtonite_api_test"
$env:FRONTEND_TEST_DATABASE_URL = "postgresql+psycopg://newtonite:local_dev_only@127.0.0.1:5433/newtonite_frontend_test"
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
Remove-Item Env:DATABASE_URL, Env:FRONTEND_TEST_DATABASE_URL
```

After an integration suite has used a test database, use a newly created `_test` database for a clean rerun rather than truncating or resetting an existing database. Compose port 5433 is bound to loopback; set `POSTGRES_HOST_PORT` if it is already occupied.

To run the HTTP workflow smoke checks against the running, seeded application:

```powershell
python scripts\e2e.py
```

Optional browser check (requires Playwright Python and a Chromium browser installed):

```powershell
python -m pip install playwright
python -m playwright install chromium
python scripts\browser_check.py
```

## Architecture and key guarantees

- API routes live under `/api/v1`; `/health` checks PostgreSQL connectivity.
- Alembic owns schema evolution. The API's container startup applies `alembic upgrade head`.
- Every item request derives team membership and role from PostgreSQL. The frontend is not an authorization boundary.
- Work-item edits and transitions use `expectedVersion`; claims use a conditional database update. A losing/stale request receives a conflict instead of overwriting current state.
- Creation idempotency, work-item writes, activity rows, and relevant outbox jobs share a transaction. The worker uses leases and `SKIP LOCKED`; notifications are persisted in the database and deduplicated by outbox-job ID.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Render configuration and manual live smoke tests. No service is considered live until it has actually been deployed and verified.
