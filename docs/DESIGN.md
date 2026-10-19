# Newtonite Ops — evaluation guide

## Feature summary

- Team-scoped work-item dashboard with SQL-backed summary counts, server-side search and filters, and cursor-based pagination.
- Work-item creation, editing, assignment/claim, comments, and status/approval workflow.
- Role-based access per team (`VIEWER`, `MEMBER`, `LEAD`, `ADMIN`).
- Activity history with actor and before/after data, committed atomically with each successful mutation.
- PostgreSQL-backed idempotency for item creation and an asynchronous transactional outbox with a separate worker.
- Login throttling, short-lived JWT authentication, token revocation on logout, request validation, and optimistic concurrency responses.
- Responsive obsidian-and-cyan operations console with a keyboard-accessible command palette (Ctrl/Cmd+K) and real, team-scoped work-item search.
- Saved filter views scoped to the signed-in user's browser storage; these are local preferences, not shared or server-persisted team views.

## Architecture

```text
Browser (React/Vite SPA)
   | HTTPS JSON API, bearer JWT, exact-origin CORS
   v
Express / TypeScript API  ---- PostgreSQL 16
   |                              |-- work items, memberships, auth state
   |                              |-- activity_events (append-only trigger)
   |                              |-- idempotency_records
   |                              `-- outbox_jobs
   `-- separate worker -----------^

Migration CLI ------------------- PostgreSQL
```

The SPA calls the API under `/api/v1`; frontend and backend share TypeScript response types in `shared/types.ts`. The API validates input with Zod and uses parameterized SQL through `pg`. PostgreSQL is the source of truth for identity, team membership, authorization, work state, audit history, idempotency, and queued jobs. The command palette searches the existing access-filtered list endpoint; saved filter views use per-user localStorage and are not presented as shared team data.

The visual system uses deep graphite/obsidian surfaces, restrained cyan and violet accents, responsive navigation, readable status/priority badges, and reduced-motion support. Dashboard numbers remain the existing SQL aggregates (`assignedToMe`, `unassignedUrgent`, `awaitingMyApproval`, `overdue`); no completion-trend, workload forecast, or other unsupported analytics are fabricated.

## Important implementation choices and trade-offs

| Concern | Implementation | Why / trade-off |
|---|---|---|
| Atomic claim | A single conditional `UPDATE` succeeds only when `assignee_id IS NULL`; exactly one competing claimant wins. | Database atomicity avoids an application mutex; losing callers receive a conflict. |
| Stale writes | PATCH and workflow updates include `expectedVersion` in the update predicate. A zero-row update becomes `409 STALE_VERSION`. | Clients must reload/reconcile after a conflict; overwrites are prevented. |
| Duplicate create requests | Unique `(actor, scope, key)` idempotency key and SHA-256 request hash are stored in the same transaction as the item. Same request replays; reusing the key with another payload conflicts. | Guarantees cover creation only; records expire after 24 hours and there is no scheduled purge. |
| Authorization | Every item operation checks membership and role against PostgreSQL. Non-members receive 404; members below the required role receive 403. | Roles can change without reissuing JWTs; authorization requires database reads. |
| Activity history | Mutation, event, and relevant outbox write share a PostgreSQL transaction. A migration trigger rejects activity UPDATE/DELETE. | Failed mutations leave no partial history; the table is an audit ledger, not a complete event-sourced state model. |
| Background jobs | Transactional outbox; worker claims with `FOR UPDATE SKIP LOCKED`, a lease, bounded retry/backoff, and an idempotent notification sink. | Delivery is at-least-once, not exactly-once. External handlers must use idempotency. |
| Persistence | PostgreSQL and explicit SQL/migrations rather than an ORM. | Migration and query behavior remain inspectable; more SQL is maintained by hand. |
| Pagination | Keyset cursor over descending item ID, with bounded page size and SQL filters. | Stable and efficient for the chosen order; arbitrary sorting is not included. |
| Authentication | Argon2id password hashes; 15-minute HS256 JWT; pinned verification algorithm; per-token logout revocation. | Simple stateless request credential plus a revocation lookup; no refresh tokens, MFA, or HttpOnly-cookie design. |
| Hosting | Static React/Vite, Express web service, managed PostgreSQL, and separate worker. | Fits Render service types; a real production deployment and first-user provisioning still need to be performed. |

Additional rationale is in [ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md); security caveats are in [SECURITY.md](SECURITY.md).

## Five-minute demonstration

Use a fresh local demo database and the documented local-only accounts. Never use the demo seed/accounts in production.

1. **0:00–0:40 — Sign-in and overview.** Sign in as `lead@demo.test`; point out team-scoped dashboard counts and role-specific navigation.
2. **0:40–1:20 — Find work.** Open the command center with Ctrl/Cmd+K and search “database”; then filter by status/priority or overdue, save a browser-local view, and load another page. Explain that item search and cursor pagination happen in SQL.
3. **1:20–2:10 — Create and audit.** Create an urgent item, open it, claim or assign it, and show the activity entry and actor. Optionally repeat the same create with its idempotency key via the API to demonstrate replay.
4. **2:10–3:10 — Workflow and authorization.** Move the item to `IN_PROGRESS`, then `AWAITING_APPROVAL`. Sign in as a member and show approval is unavailable/denied; sign in as a lead and approve it. Open activity to show the transition/approval history.
5. **3:10–4:10 — Concurrency.** In two tabs, load the same version and save competing edits; one succeeds and the stale update returns 409 without overwriting. Alternatively show the 9-way concurrent claim test, where exactly one succeeds.
6. **4:10–5:00 — Reliability and evaluation evidence.** Show the worker/outbox, migrations, and commands/results for API (58), UI (22), and HTTP E2E (71) tests. State clearly that live hosting has not been deployed or verified.

## Likely evaluator questions

**How do you prevent two people claiming the same item?**
The API performs a conditional database update that only matches an unassigned row. Concurrent requests serialize at PostgreSQL; one changes the row, and subsequent requests get `ALREADY_CLAIMED`. The successful update and activity event commit together.

**How do you prevent overwriting a newer edit?**
Clients send `expectedVersion`. The update predicate includes that version and increments it on success. A stale version returns `409 STALE_VERSION`; no stale write or activity record is committed.

**What does idempotency protect?**
Item creation accepts an idempotency key scoped to the actor and operation. The request hash and response are stored in the creation transaction. A matching retry replays the response; a different payload with the same key conflicts. It is not a general idempotency layer for every endpoint.

**How is authorization enforced?**
The API resolves team roles from the database on every request. Non-members receive 404 to avoid revealing that an item exists; members who lack the required role receive 403. UI hiding is only a convenience, not the security boundary.

**Can activity be inconsistent with a work-item change?**
The mutation and its event are written in one PostgreSQL transaction, so either both commit or both roll back. The database trigger prevents updates/deletes of recorded activity. This is append-only audit history, not event sourcing.

**Can an outbox event run more than once?**
Yes. The worker provides at-least-once delivery with leases and retry/backoff. The included notification sink is unique by job ID and idempotent. External handlers must also pass a provider idempotency key.

**Is the project live or production-ready?**
No live deployment has been performed. Local checks and deployment instructions exist, but repository hosting, Render service provisioning, a safe first-admin procedure, and live endpoint smoke tests remain.

**Why Express/TypeScript instead of FastAPI?**
That is the implementation in this workspace: Express/TypeScript API, React/Vite frontend, PostgreSQL, and a Node worker. Deployment and evaluation claims must match the code rather than a different requested stack.
