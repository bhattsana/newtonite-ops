# Requirements and evidence matrix

This matrix identifies the implementation surface and how to verify it. The status is intentionally not pre-filled: record only results from the current validation run.

| Requirement | Implementation | Verification |
|---|---|---|
| FastAPI starts and PostgreSQL health check works | `backend/app/main.py` | `GET /health` with PostgreSQL running |
| Cookie authentication and CSRF | `backend/app/api/auth.py`, `backend/app/security.py`, `backend/app/api/csrf.py` | Backend integration tests; verify missing CSRF is rejected |
| Team-scoped authorization and role restrictions | `backend/app/authz.py`, `backend/app/api/` | Backend tests and `python scripts/e2e.py` |
| Work-item create/edit/search/filter/pagination | `backend/app/api/items.py` | Backend/frontend integration and HTTP end-to-end checks |
| Claim race and stale-version handling | `backend/app/api/items.py` | Concurrent backend tests; HTTP smoke check |
| Lead approval, comments, and activity history | `backend/app/api/items.py` | Backend and frontend integration tests |
| Idempotent creation and transactional outbox | `backend/app/api/items.py`, `backend/app/worker/main.py` | Backend tests, worker test, duplicate-request E2E |
| Alembic fresh schema and recognized legacy adoption | `backend/alembic/` | `alembic upgrade head` against a dedicated fresh test DB and current DB head check |
| Real React/Vite frontend to API integration | `frontend/src/`, `frontend/tests/` | `npm --prefix frontend test` |
| Local Docker Compose services and health | `docker-compose.yml` | `docker compose config --quiet`, service health requests |
| Render deployment and live user journey | `DEPLOYMENT.md` | Not verified until services are provisioned and live URLs are tested |

The tests require separate databases ending in `_test` or `-test`. Never point a test command at production or a valuable development database. Do not interpret the listed verification commands as a report that they have already passed.
