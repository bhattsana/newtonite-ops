"""Create the application schema or safely adopt the complete legacy schema."""

from alembic import op
from sqlalchemy import inspect, text

from app.models import Base

revision = "001_initial"
down_revision = None
branch_labels = None
depends_on = None

CORE_TABLES = {
    "users",
    "teams",
    "memberships",
    "work_items",
    "activity_events",
    "comments",
    "idempotency_records",
    "outbox_jobs",
    "notifications",
}
LEGACY_MIGRATIONS = {
    "001_init.sql",
    "002_auth_hardening.sql",
    "003_activity_append_only.sql",
}


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(inspect(bind).get_table_names(schema="public")) - {"alembic_version"}
    if not existing:
        Base.metadata.create_all(bind=bind)
        return

    missing = CORE_TABLES - existing
    if missing:
        raise RuntimeError(
            "Refusing to migrate a partially initialized database. "
            f"Missing legacy application tables: {', '.join(sorted(missing))}. "
            "Use a new empty database or repair the schema after backup."
        )
    if "schema_migrations" in existing:
        columns = {column["name"] for column in inspect(bind).get_columns("schema_migrations")}
        if "name" not in columns:
            raise RuntimeError("Refusing to adopt schema_migrations with an unknown layout.")
        recorded = set(bind.execute(text("SELECT name FROM schema_migrations")).scalars())
        unknown = recorded - LEGACY_MIGRATIONS
        if unknown:
            raise RuntimeError(
                "Refusing to adopt a database with unknown legacy migrations: "
                + ", ".join(sorted(unknown))
            )
        if not recorded:
            raise RuntimeError("Refusing to adopt an unverified legacy schema without migration records.")


def downgrade() -> None:
    raise RuntimeError("The initial schema migration is intentionally irreversible to protect existing data.")
