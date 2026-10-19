# Product and evaluation guide

## Feature summary

- **Operations dashboard:** team-scoped active work, summary counts, search, status/priority/team/assignee filters, overdue views, and cursor pagination.
- **Work management:** create, edit, assign, claim, comment, and move items through role-gated status transitions.
- **Approval workflow:** members can submit work for approval; team leads/admins perform approval decisions.
- **Auditability:** transactional activity history records who changed work and the relevant before/after values.
- **Security:** opaque HttpOnly cookie sessions, CSRF checks, login throttling, strict request validation, team-scoped API authorization, CORS allowlisting, and production cookie/secret guards.
- **Reliability:** optimistic concurrency, creation idempotency, Alembic migrations, and a separate transactional-outbox worker.
- **Interface:** responsive command-center layout with accessible form labels, list/detail screens, and keyboard-operable navigation.

## Design and trade-offs

| Concern | Current choice | Trade-off |
|---|---|---|
| Authentication | HMAC-hashed opaque server-side sessions in HttpOnly cookies; CSRF token for writes | Session lookup is database-backed; no MFA, recovery, or refresh-token family yet |
| Authorization | Team membership and role loaded from PostgreSQL for every operation | Permission changes take effect immediately, with an additional DB read/join |
| Concurrent claims | Conditional database update | Single atomic winner; losers receive a conflict |
| Stale edits | `expectedVersion` optimistic locking | Clients must reload after a 409 |
| Duplicate create | Actor/scope/key uniqueness and payload hash in transaction | Applies to item creation, not every mutation; expired records are lazily replaced |
| Activity history | Mutation and activity event commit in one transaction; DB trigger rejects UPDATE/DELETE | Append-only audit trail, not full event sourcing |
| Outbox | PostgreSQL queue with `SKIP LOCKED`, lease, retry/backoff and idempotent database sink | At-least-once processing; current handler writes an in-app notification row only |
| Search and pagination | SQL `ILIKE` plus keyset cursor | Search may require trigram/full-text indexes as data grows; no alternate sort order |
| Saved filters | Browser-local preferences | Not synchronized across browsers or users |

## Five-minute demonstration

Use a disposable local database seeded only in development; do not use demo users in production.

1. **0:00–0:40 — Sign in and orient.** Sign in as `lead@demo.test` / `demo-local-only`. Point out the dashboard totals and role-aware navigation.
2. **0:40–1:20 — Find work.** Search for a seeded item, filter by status or priority, and use the next page. Explain that search and cursor pagination run in PostgreSQL.
3. **1:20–2:00 — Create and inspect.** Create a work item, open its detail, and show the actor and creation event in activity history.
4. **2:00–3:00 — Assign and progress.** Assign/claim the item and move it through `IN_PROGRESS` to `AWAITING_APPROVAL`. Show that a member cannot approve it.
5. **3:00–3:45 — Lead approval.** Sign in as a lead and resolve/approve the item; reopen activity to show the recorded outcome.
6. **3:45–4:30 — Concurrency and retries.** Explain `expectedVersion`, the claim race, and the idempotency key. Run `python scripts/e2e.py` for executable evidence.
7. **4:30–5:00 — Architecture and boundaries.** Explain the transaction/outbox, worker, migrations, and local test results. State whether any live service has actually been verified; do not imply deployment otherwise.

## Likely evaluator questions

**How is a simultaneous claim handled?**
The claim endpoint updates only a row whose `assignee_id` is still null. PostgreSQL serializes the competing updates; one succeeds and the others receive a conflict. The winning update and activity row are committed together.

**How do you avoid lost edits?**
Clients send `expectedVersion`. The server checks and increments the version in the write transaction; stale versions return `409 STALE_VERSION` and do not commit a new activity entry.

**What does idempotency cover?**
Work-item creation accepts an idempotency key scoped to the actor and operation. The request hash and response are persisted transactionally. A matching retry replays the response; reusing the key with another payload returns a conflict.

**Where is authorization enforced?**
On the server, from current PostgreSQL membership data. Viewers cannot mutate; lead/admin-only actions are checked by the API. UI hiding is only a usability feature.

**Can activity disagree with the item?**
The mutation and activity record share a PostgreSQL transaction, so they commit or roll back together. A database trigger makes recorded activity append-only.

**Is outbox delivery exactly once?**
No. The worker retries and may redeliver after a crash/expired lease. Its current notification insert is idempotent by unique job ID; external side effects would also need idempotency.

## Further details

See [ARCHITECTURE.md](./ARCHITECTURE.md), [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md), [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md), and [DEPLOYMENT.md](./DEPLOYMENT.md).
