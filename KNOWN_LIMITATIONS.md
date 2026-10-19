# Known limitations

## Deployment

- No production service has been deployed or live endpoint verified in this workspace. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) and record live checks only after they actually pass.
- Production requires a managed PostgreSQL 16 database, a separately configured frontend/API origin, secrets in the host's secret manager, and an initial team/user provisioned with `python -m app.provision_user`.
- Backups, restore procedures, monitoring, and alerting must be configured with the selected host; the repository does not provision them.

## Product and security

- There is no public registration, password reset, MFA, or in-app user administration. The CLI provisioner can create a first team/admin or add an account to a specified team.
- The outbox worker writes notification rows in PostgreSQL. Email, SMS, push delivery, and an external provider are not configured.
- Login throttling is per email/IP and is database-backed; it is not a distributed account-level lockout policy.
- Cookie sessions and CSRF protection are implemented, but session revocation and login audit history do not have a user-facing administration screen.
- Saved filter views are browser-local, not synchronized or team-shared.

## Scale and behavior

- Search uses PostgreSQL `ILIKE` patterns; large datasets may need trigram/full-text indexes.
- Pagination is keyset-based by descending item ID; arbitrary sort fields are not offered.
- Outbox delivery is at-least-once. A handler that runs longer than its lease could be retried, so all side effects must be idempotent.
- Idempotency is implemented for item creation only. Expired keys are cleaned when reused; there is no periodic retention job.
- API/worker database pool sizing must be considered when scaling replicas against a managed database connection limit.

## Verification

- Unit/integration results must be read from the current run; historical summaries are not proof of current state.
- Live hosting, production credentials, backup restore, cross-browser/device compatibility, and external notification delivery are not claimed as verified by local checks.
- Optional browser validation requires Playwright and Chromium. It is separate from the React integration tests and HTTP end-to-end script.
