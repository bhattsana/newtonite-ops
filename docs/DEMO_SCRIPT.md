# Five-minute demonstration

Use a disposable local database and the development-only seed accounts. Never use demo credentials in production. This script is a guide, not evidence that an action passed; confirm the current run and running service before presenting it.

1. Sign in as `lead@demo.test` with the local-only password `demo-local-only`. Point out the team-scoped dashboard summaries.
2. Search for a known seeded work item; apply a status/priority filter and load another cursor page.
3. Create a work item and show its detail page and `CREATED` activity entry.
4. Assign or claim the item. Explain that the claim is a conditional PostgreSQL update.
5. Transition it to `IN_PROGRESS`, then `AWAITING_APPROVAL`. Show member approval is denied and a lead/admin can approve.
6. Show the resulting status and actor in the activity history.
7. Explain how stale `expectedVersion` values return 409 and how a repeated `Idempotency-Key` replays item creation.
8. Run `python scripts\e2e.py` for real HTTP/PostgreSQL workflow checks when the API is seeded and available.
9. Describe Alembic and the outbox worker. Clearly state whether deployment and live endpoints have actually been verified.

See [DESIGN.md](../DESIGN.md) for suggested timings and evaluator questions.
