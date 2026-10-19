# Known limitations

## Deployment and evaluation
- **No live deployment:** Render (or another production host) has not been configured or deployed, and no live endpoint has been verified. The Render plan is in [DEPLOYMENT.md](../DEPLOYMENT.md).
- **First production user provisioning is manual and not yet documented as an operational procedure.** There is no registration or user-administration API. Do not use `npm run seed` in production: it truncates application data and creates demo accounts with a shared, known password. Define and review a safe, one-time provisioning procedure before go-live.
- The downloaded workspace has no `.git` metadata, so there is no repository status/history to audit from this copy.
- The original challenge PDFs were not available; the requirements matrix reflects the prompts and implementation evidence available in this workspace.
- Browser evaluation uses Chromium and emulated viewport sizes only; Safari, Firefox, and physical touch devices are not verified.

## Security
- The JWT is kept in `sessionStorage`. CSP limits script injection and exfiltration, but script executing in the app origin can still read the token and act as the user.
- There is no refresh token: sessions last 15 minutes and users must sign in again.
- There is no MFA, password-reset flow, or password-strength policy.
- Login throttling is per email and IP, not per account. Behind a proxy, set `TRUST_PROXY` only to the correct trusted hop count.
- There is no structured request logging or request ID, and no login audit log.
- Deliver the SPA CSP as an HTTP response header as well as its current meta policy to set `frame-ancestors`; the current static-site config depends on host support for response headers.

## Behaviour and scale
- Idempotency keys apply to item creation only. Keys expire after 24 hours and are purged only when reused; no scheduled purge is provided.
- Outbox delivery is at-least-once. Handlers must be idempotent; a job that outlives its lease may be delivered again. Retry, lease, and backoff defaults are code constants.
- Search uses PostgreSQL `ILIKE` and may scan as data grows. There are no alternate sort modes.
- Saved work views are stored per user in that browser's localStorage; they do not synchronize across devices or users. The detail UI does not edit due date or item type.
- There are no chart/time-series endpoints, completion trend records, or enough normalized workload history to support the requested trend and forecasting visuals. The dashboard therefore keeps to four accurate SQL aggregates rather than displaying invented charts or scores.
- The application uses a dark visual theme, but has no in-app theme toggle. The constellation/network visualization and notifications center are not implemented because the current domain/API has no meaningful graph or persisted read/unread notification model.
- The pool permits up to 20 database connections per process; scale the managed database connection allowance with API and worker instance counts.
- Shared TypeScript types are a compile-time contract, not a complete runtime schema.

## Validation scope
- Latest local Windows validation: 58 API tests, 22 UI tests (including permission-aware command palette and browser-local saved-filter coverage), fresh-database migrations, API/frontend type checks, and a production frontend build passed. Lint has zero errors and 16 existing `any` warnings. The HTTP E2E script passed all 71 checks against the local API. A local Chromium walkthrough verified sign-in, real dashboard metrics, team-scoped command-palette search, and the narrow viewport layout; the existing browser walkthrough covers search/filter, pagination, create, claim, assignment, approval, role controls, and activity history.
- Earlier local runs passed the 111-check Chromium suite, Docker image builds, Compose configuration, and an isolated Compose runtime journey. These are not a substitute for a production deployment or live endpoint checks.
- Both full test suites modify their explicitly designated test databases. API tests reset the `public` schema; web setup seeds/truncates its database. Never use production or valuable development databases.

See [SECURITY.md](SECURITY.md), [REQUIREMENTS_MATRIX.md](REQUIREMENTS_MATRIX.md), and [DEPLOYMENT.md](../DEPLOYMENT.md).
