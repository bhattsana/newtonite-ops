"""Add opaque cookie sessions; preserve existing JWT-era auth tables."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "002_auth_sessions"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(inspect(bind).get_table_names(schema="public"))
    if "login_attempts" not in tables:
        op.create_table(
            "login_attempts",
            sa.Column("key", sa.Text(), primary_key=True),
            sa.Column("failures", sa.Integer(), nullable=False),
            sa.Column("window_start", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
    if "revoked_tokens" not in tables:
        op.create_table(
            "revoked_tokens",
            sa.Column("jti", sa.Text(), primary_key=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("revoked_tokens_expiry", "revoked_tokens", ["expires_at"])
    if "sessions" not in tables:
        op.create_table(
            "sessions",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
            sa.Column("csrf_hash", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("sessions")
