You are a senior full-stack engineer working directly inside my existing Newtonite Ops repository. Transform the actual application into the FastAPI + PostgreSQL backend and React + TypeScript frontend architecture described below. Do not merely update documentation or create placeholder folders.

## Target repository structure

- `backend/app/api/` — FastAPI routers and endpoints
- `backend/app/worker/` — notification/outbox worker
- `backend/app/tests/` — backend tests
- `backend/app/main.py` — FastAPI application
- `backend/app/models.py` — SQLAlchemy models
- `backend/app/schemas.py` — Pydantic schemas
- `backend/app/security.py` — authentication, sessions and CSRF protection
- `backend/app/authz.py` — team-scoped authorization
- `backend/app/seed.py` — safe development seeding
- `backend/alembic/` — database migrations
- `backend/requirements.txt`
- `backend/.env.example`
- `frontend/src/` — React application
- `frontend/tests/` — frontend tests
- `frontend/package.json`
- `frontend/.env.example`
- `scripts/`
- `docs/`
- `docker-compose.yml`
- `README.md`
- `ARCHITECTURE.md`
- `DESIGN.md`
- `ENGINEERING_DECISIONS.md`
- `KNOWN_LIMITATIONS.md`

## Critical migration requirements

1. Inspect every existing source file, dependency, migration, test and Docker configuration before changing anything.
2. Preserve the existing application's useful functionality, visual design, workflows, and test coverage. Reimplement features in the target architecture rather than silently dropping them.
3. Move the backend to Python 3.11+, FastAPI, Pydantic, SQLAlchemy 2, Alembic and PostgreSQL 16.
4. Build the frontend using React, TypeScript, Vite, Tailwind CSS and accessible UI components.
5. Implement real database-backed authentication, secure cookie sessions, CSRF protection, team-scoped authorization, work-item creation and assignment, comments, status transitions, lead-only approvals, activity history and dashboard summaries.
6. Implement concurrency-safe claims, optimistic version checking, idempotent creation and a transactional outbox with an idempotent notification worker.
7. Preserve and adapt the current design into a polished, responsive Newtonite Ops command-center interface. Include the dashboard, work-item list and detail pages, activity, teams, settings, search, filters, accessible list alternatives and the 3D constellation if the existing implementation supports it.
8. Use Alembic migrations and safe seed logic. Never silently delete data, reset a database, or expose real secrets.
9. Update Docker Compose, environment examples, scripts, architecture documentation, setup instructions and test commands so they match the final code exactly.
10. Preserve useful existing Git history and configuration. Do not delete `.git`, force-push, or overwrite remote history.

## Execution process

- First audit the current codebase and write a concise migration plan.
- Implement the migration in small, coherent steps.
- Update imports, configuration, API clients, database models, migrations, tests and deployment files consistently.
- Remove obsolete implementation files only after the replacement works and all references have been checked.
- Install or update dependencies where possible.
- Run the available backend tests, frontend tests, lint checks, production build and migration checks.
- Fix failures caused by your changes. Do not claim checks passed unless you actually ran them.
- If a service or test cannot run in this environment, document the exact blocker and the command needed to verify it.
- Verify that the application can run from a fresh clone on Windows using the documented commands.

## Final acceptance criteria

The actual backend must start as a FastAPI application. The actual frontend must start through Vite and communicate with the backend. PostgreSQL migrations must work. Authentication and authorization must be enforced server-side. The core workflows must be covered by tests. Docker Compose and the README must match the real implementation.

Do not stop after generating the plan or creating folders. Continue implementing, testing, fixing and documenting until the migration is complete or a genuine external blocker prevents further work.

At the end, report:
1. What changed.
2. The final repository structure.
3. Tests and builds actually executed, including results.
4. Remaining blockers and known limitations.
5. Exact local startup commands.
6. Files that should be committed and the safe Git commands to publish the changes.

Do not push to GitHub automatically. Leave publishing for explicit confirmation after reviewing the changes.
