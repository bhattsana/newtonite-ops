# Security notes

## Implemented controls

- Passwords are verified using Argon2 password hashes. API session tokens are random opaque values; only HMAC-SHA256 hashes are stored in PostgreSQL.
- Session cookies are HttpOnly. Production requires `COOKIE_SECURE=true`; cookie attributes are configured for the cross-origin frontend/API use case.
- `/api/v1/auth/csrf` issues a CSRF token. State-changing endpoints require it in `X-CSRF-Token`.
- Failed login attempts are tracked in PostgreSQL and throttled by email and client IP.
- Team membership and roles are loaded from the database. Non-members do not receive an item merely by guessing its ID.
- Pydantic request models reject unknown fields. API errors avoid stack traces and internal exception details.
- CORS uses exact origins and credentials; production requires HTTPS origins. Security headers are added by FastAPI.
- Production startup requires a session secret of at least 32 characters. Never commit `.env` or store production secrets in a frontend variable.
- Demo seeding is restricted to `APP_ENV=development`. `python -m app.provision_user` creates an initial account with a prompted password and does not print the password.

## Operational safeguards

- Tests refuse to run against database names not ending in `_test` or `-test`; frontend tests also require a separate `FRONTEND_TEST_DATABASE_URL`.
- Migrations reject unknown or partial schemas rather than resetting them. Back up databases before production releases and stop on migration/adoption errors.
- Do not delete Compose volumes to troubleshoot credentials. Updating `POSTGRES_PASSWORD` does not update the database role in an already initialized volume.
- Keep the worker and API on private database networking where available. Use a managed secret store for `DATABASE_URL` and `SESSION_SECRET`.

## Limitations and review

There is no MFA, password recovery, registration, account administration UI, or external notification provider. The in-app notification handler is idempotent, but external side effects would need their own idempotency strategy. The API uses database-backed session checks; scale connection pools and rate limits for the hosting plan.

This document is an implementation summary, not a formal security audit or proof of production configuration. See [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) and [DEPLOYMENT.md](../DEPLOYMENT.md).
