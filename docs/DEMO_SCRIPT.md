# Five-minute demo

For a timed walkthrough and evaluator Q&A, see [DESIGN.md](DESIGN.md).

1. Sign in as `lead@demo.test` / `demo-local-only`. This is a local-demo credential only.
2. Show the team-scoped dashboard counts.
3. Open the command center with Ctrl/Cmd+K and search for “database.” Filter by status or overdue, save a browser-local view, and use **Load more** to show cursor pagination.
4. Create an urgent work item, claim or assign it, and show the activity entry and actor.
5. Move it through `IN_PROGRESS` to `AWAITING_APPROVAL`. Sign in as `member@demo.test` and show approval is denied/unavailable; sign back in as lead and approve.
6. In two tabs, edit the same version: show the stale save returns 409 and does not overwrite the winning change.
7. Explain the conditional-update claim race, transaction-bound activity history, idempotent create key, and outbox worker. Use test output rather than claiming unobserved behavior.
8. Report the latest local results: API 58 tests, UI 22 tests, migrations on a fresh test database, and the prior HTTP E2E 71 checks. A live deployment has not been performed.

The demo accounts and the seed script are strictly for disposable local/demo databases. The seed script truncates existing data.
