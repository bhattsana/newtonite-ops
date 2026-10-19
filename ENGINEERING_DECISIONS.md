# Engineering decisions

1. **FastAPI with SQLAlchemy 2 and PostgreSQL.** Pydantic validates API contracts; SQLAlchemy owns queries/transactions and Alembic owns schema evolution. This makes database guarantees explicit while retaining typed Python application boundaries.
2. **Cookie sessions rather than browser bearer tokens.** Random opaque session IDs are HMAC-hashed in PostgreSQL and sent as HttpOnly cookies. A separate CSRF token is required for state-changing requests. The trade-off is database-backed session validation and the need for exact credentialed CORS.
3. **Team roles are database state.** The API checks each caller's membership and role on protected requests rather than trusting UI state or a long-lived role claim. This costs queries but makes role changes immediate.
4. **Conditional writes for claims and optimistic versions for edits.** PostgreSQL row predicates provide atomic claims; `expectedVersion` prevents stale changes without holding locks across an application round trip.
5. **Transactional activity and outbox.** Mutations, their audit records, and relevant jobs share a transaction. This avoids both lost activity and orphaned queued jobs. The worker processes jobs at least once, so handlers must be idempotent.
6. **Idempotency limited to creation.** A unique `(actor, scope, key)` row and canonical payload hash are stored with the new item and response. Same-payload retries replay; payload mismatch conflicts. Expired rows are replaced when a key is reused rather than by a background purge.
7. **Keyset pagination and SQL-side filters.** Lists use a descending ID cursor with a maximum page size, avoiding expensive deep offsets. Arbitrary sorting and full-text search are not in scope.
8. **Safe migrations over automatic reset.** Fresh databases are migrated. A recognized legacy schema is adopted additively; a partial or unknown schema is rejected. No migration or seed path drops existing data.
9. **Separate worker deployment.** The outbox worker shares database configuration but does not serve HTTP. Its persisted notification sink is idempotent; real email/SMS delivery is not implemented.
10. **Preserve the existing UI, avoid unsupported analytics.** React views keep the operational command-center style and workflows; dashboard figures remain SQL-backed counts instead of invented trends or forecasts.
