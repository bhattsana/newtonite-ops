"""Enforce append-only activity history."""

from alembic import op
from sqlalchemy import text

revision = "003_append_only_activity"
down_revision = "002_auth_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    exists = bind.execute(
        text(
            "SELECT 1 FROM pg_trigger "
            "WHERE tgname='activity_events_no_update_delete' AND NOT tgisinternal"
        )
    ).scalar()
    if not exists:
        op.execute(
            """
            CREATE FUNCTION activity_events_immutable() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'activity_events is append-only';
            END
            $$
            """
        )
        op.execute(
            """
            CREATE TRIGGER activity_events_no_update_delete
            BEFORE UPDATE OR DELETE ON activity_events
            FOR EACH ROW EXECUTE FUNCTION activity_events_immutable()
            """
        )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS activity_events_no_update_delete ON activity_events")
    op.execute("DROP FUNCTION IF EXISTS activity_events_immutable()")
