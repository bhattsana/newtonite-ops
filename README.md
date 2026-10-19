# Newtonite Ops — Operations Under Pressure
Internal work-management app: create, claim, assign, approve and track work with team-scoped access.
The responsive dark operations console includes real SQL-backed queue metrics, keyboard command search (Ctrl/Cmd+K), URL-shareable filters, and per-user browser-local saved views.
**Layout:** `src/` Express API + outbox worker · `db/migrations/` versioned SQL migrations · `shared/types.ts` API types used by both sides · `tests/` API integration tests · `scripts/e2e.mjs` HTTP end-to-end check · `scripts/browser_check.py` real-browser check · `web/` React + Vite SPA (+ UI tests) · `docs/`.
**Stack:** React 19, TypeScript 6.0 (strict), Vite, TanStack Query, React Router · Node 22, Express, Zod, `pg` (raw SQL), argon2, JWT · PostgreSQL 16 · Vitest, Supertest, React Testing Library, ESLint, Playwright (browser check only).
TypeScript is pinned to 6.0.x because typescript-eslint does not support TypeScript 7 yet.

## Prerequisites
Node 22+, PostgreSQL 16 reachable from your machine. Docker is optional.

## Run locally (no Docker)
    createdb newtonite                       # or any name; use your own user/password in the URL
    npm install && (cd web && npm install)
    export DATABASE_URL=postgres://USER:PASS@localhost:5432/newtonite
    export JWT_SECRET=any-local-value        # >= 32 chars is REQUIRED when NODE_ENV=production
    npm run migrate && npm run seed          # seed wipes and reloads demo data (refuses NODE_ENV=production unless ALLOW_SEED=1); `npm run seed:large` = 5,000 items
    npm run dev                              # API on http://localhost:3000   (terminal 1)
    npm run worker                           # outbox worker                  (terminal 2)
    cd web && cp .env.example .env && npm run dev    # SPA on http://localhost:5173   (terminal 3)
Open http://localhost:5173. The API defaults to `CORS_ORIGINS=http://localhost:5173`.

### Windows PowerShell

With PostgreSQL 16 already running, create a disposable local demo database first (the seed command below **replaces all data** in the named database; do not reuse a database with data you need):

```powershell
createdb newtonite_demo
Set-Location 'C:\path\to\newtonite-ops'
npm ci
npm --prefix web ci
$env:DATABASE_URL = 'postgresql://<user>:<password>@localhost:5432/newtonite_demo'
$env:JWT_SECRET = 'local-demo-only-secret-change-before-production'
npm run migrate
npm run seed
npm run dev
```

In a second PowerShell terminal, set the same API environment values and start the outbox worker:

```powershell
Set-Location 'C:\path\to\newtonite-ops'
$env:DATABASE_URL = 'postgresql://<user>:<password>@localhost:5432/newtonite_demo'
$env:JWT_SECRET = 'local-demo-only-secret-change-before-production'
npm run worker
```

In a third terminal, start the SPA:

```powershell
Set-Location 'C:\path\to\newtonite-ops'
$env:VITE_API_BASE_URL = 'http://localhost:3000'
npm --prefix web run dev
```

Open `http://localhost:5173`. This seeded demo is for local evaluation only. For test suites, use separate disposable `*_test` databases; never use the demo database as a test target.

## Docker Compose (local development)
In PowerShell, generate an ephemeral local JWT secret and start Compose:
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $env:JWT_SECRET = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    docker compose up --build
    docker compose run --rm -e ALLOW_SEED=1 api npm run seed
Compose requires an explicit JWT secret. Its PostgreSQL credentials and demo accounts are for local development only; do not use this Compose configuration as a production deployment.
Seeding erases and recreates the Compose database contents; only run it for a fresh demo database or when you intentionally want to replace its data.
The web image builds from the repository root context because it imports `shared/`. PostgreSQL uses a persistent named volume; `docker compose down` preserves it. Do not use `docker compose down -v` unless you explicitly intend to discard that database.

## Demo accounts (LOCAL ONLY — shared password `demo-local-only`)
admin@demo.test (ADMIN, all teams) · lead@demo.test (LEAD Platform) · support.lead@demo.test (LEAD Support) · member@demo.test (MEMBER Platform+Support) · member2@demo.test (MEMBER Platform) · viewer@demo.test (VIEWER) · security@demo.test (LEAD Security) · nora@demo.test (MEMBER Support+Security, not in Platform)

## Checks
| What | Command |
|-|-|
| One-time: create wipeable test DBs | `createdb newtonite_test && createdb newtonite_web_test` |
| Lint (0 errors; `any` warnings remain) | `npm run lint` |
| API type-check | `npm run typecheck` |
| API integration tests: concurrency, workflow matrix, authorization matrix, activity atomicity, worker lifecycle, migrations, contract, production CORS configuration (58) | Set `DATABASE_URL` to the connection string for a dedicated `*_test` database, then run `npm test` |
| Web type-check + production build | `cd web && VITE_API_BASE_URL=http://localhost:3000 npm run build` |
| Web UI tests (22; they start the real API on :3200) | Set `WEB_TEST_DATABASE_URL` to a different dedicated `*_test` database, then run `npm test` from `web/` |
| HTTP end-to-end (71 checks) against a running, freshly seeded API | `BASE=http://localhost:3000 DATABASE_URL=<same db> npm run e2e` |
| Real-browser check (111 checks; needs Chromium + `pip install playwright`, API stopped, built SPA served on :5173, fresh seeded DB) | `JWT_SECRET=<api secret> DATABASE_URL=<db> CHROME=/path/to/chrome AXE=/path/to/axe.min.js python3 scripts/browser_check.py` |
Test commands require explicit database URLs and refuse targets whose names do not end in `_test` or `-test`. The API suite drops and recreates its target's `public` schema; the web suite seeds/truncates its target. Keep both databases separate from development and production, and never point them at a database with data you need.

## Environment
**API (runtime):** `DATABASE_URL`, `JWT_SECRET` (>=32 chars, enforced when `NODE_ENV=production`), `CORS_ORIGINS` (local default is `http://localhost:5173`; production requires comma-separated exact HTTPS origins), `PORT`, optional `LOGIN_MAX_FAILURES` (default 10 failed sign-ins per email+IP per 15 min), optional `TRUST_PROXY` (set only to the correct trusted proxy hop count, so rate limiting sees real client IPs).
**Web (build time, PUBLIC — never put secrets here):** `VITE_API_BASE_URL`. Optional `VITE_SHOW_DEMO_HINT=true` shows the demo accounts on the login screen (demo deployments only; production builds hide them by default).

## Deploy API and frontend separately
For exact Render service settings, production environment variables, migration rollout, worker configuration, and live smoke tests, see [DEPLOYMENT.md](./DEPLOYMENT.md).

**Database:** provision managed PostgreSQL 16; copy its connection string.
**API host (any Node 22 host):** build `npm ci`; start `npm run migrate && npm start`; set `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET=$(openssl rand -hex 32)`, `CORS_ORIGINS=https://<exact frontend origin>`, `PORT` if required. Run a second process `npm run worker` with the same env. `npm run migrate` applies `db/migrations/*.sql` in order and records them in `schema_migrations` (an advisory lock makes concurrent runs safe; re-running is a no-op; a database created before the runner existed is upgraded in place). Seed only for demos (`npm run seed` wipes data).
**Frontend host (any static host):** `cd web && npm ci && VITE_API_BASE_URL=https://<api origin> npm run build`. The build needs `../shared` next to `web/` (keep the repo layout). Publish `web/dist` with an SPA fallback (all paths -> `index.html`).
**Verify:** `GET <api>/health` -> 200; sign in through the deployed SPA; list, create, claim and approve an item; check API logs. Repeat with the CORS origin deliberately wrong to confirm browsers are blocked.
**No production deployment has been performed or verified.**

## API (/api/v1)
`POST auth/login|logout`, `GET auth/me`, `GET teams`, `GET teams/:id/members`, `GET dashboard/summary`, `GET|POST items`, `GET|PATCH items/:id`, `POST items/:id/claim|transition`, `GET items/:id/activity`, `GET|POST items/:id/comments`, `GET /health`.
List filters: `status, teamId, assigneeId, unassigned, priority, type, overdue, active, approvable, q, limit (<=100), cursor`. Errors: `{error:{code,message,details}}` with 400/401/403/404/409/413/422.

## Verification status
Latest native Windows verification: 58 API tests and 22 UI tests passed against separate disposable PostgreSQL databases. Fresh database migration checks, API/web type checks, and the production frontend build passed. Lint had zero errors and 16 existing `any` warnings; Docker Compose configuration validated with an explicit ephemeral secret. The HTTP E2E script passed all 71 checks against the local API and a separately seeded test database. A local Chromium walkthrough verified authentication, the responsive dashboard, command-palette team-scoped search, and the existing create/claim/assignment/approval/activity flow; the narrow viewport had no document-level horizontal overflow. The exhaustive 111-check Chromium suite, Docker image builds, and isolated Compose runtime check passed in prior verification but were not repeated. No production deployment has been performed; Safari, Firefox, and physical touch devices are not verified.
See `docs/KNOWN_LIMITATIONS.md` and `docs/SECURITY.md`.

## Evaluation documents
- [Feature, architecture, trade-offs, five-minute walkthrough, and evaluator Q&A](docs/DESIGN.md)
- [Architecture details](docs/ARCHITECTURE.md)
- [Engineering decisions](docs/ENGINEERING_DECISIONS.md)
- [Requirements and verification matrix](docs/REQUIREMENTS_MATRIX.md)
- [Known limitations and unverified items](docs/KNOWN_LIMITATIONS.md)
- [Five-minute demo steps](docs/DEMO_SCRIPT.md)
- [Render deployment and smoke-test guide](DEPLOYMENT.md)

## Troubleshooting
| Symptom | Cause / fix |
|-|-|
| `DATABASE_URL is not set` on start, migrate or seed | export it (see "Run locally"); there is no default |
| `Refusing to migrate: … some application tables` | the database is not empty and not a Newtonite database; point at an empty one |
| `Refusing to migrate: … migrations this code does not know about` | the database is newer than this code; deploy the newer version |
| `Migration NNN_x.sql failed and was rolled back` | fix the SQL; nothing from that file was applied, re-run `npm run migrate` |
| Test command refuses its database URL | Test commands require an explicit dedicated database whose name ends in `_test` or `-test`; the API suite resets its schema and the web suite truncates/reseeds data |
| `Refusing to seed: NODE_ENV=production` | seeding wipes data; set `ALLOW_SEED=1` only if you really mean it |
| API exits with `JWT_SECRET must be set (>= 32 chars)` | set a long random secret when `NODE_ENV=production` |
| Browser shows CORS errors | `CORS_ORIGINS` must be the exact frontend origin (scheme+host+port, no trailing slash) |
| "Too many failed sign-in attempts" | wait 15 minutes, or `DELETE FROM login_attempts` in a dev database; behind a proxy set `TRUST_PROXY` so users are not all one IP |
| Notifications never appear | the worker is a separate process: run `npm run worker`; failed jobs show `status='FAILED'` and `last_error` in `outbox_jobs` |
| Web build fails with a missing `../shared` | build from the repo layout (or the repo-root Docker context): `web/` needs `shared/` beside it |

## Docs
`docs/REQUIREMENTS_MATRIX.md` · `docs/ENGINEERING_DECISIONS.md` · `docs/ARCHITECTURE.md` · `docs/SECURITY.md` · `docs/KNOWN_LIMITATIONS.md` · `docs/DEMO_SCRIPT.md`
