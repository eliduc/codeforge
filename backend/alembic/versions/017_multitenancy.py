"""multi-tenancy: add user_id to sessions, webhooks, session_templates

Revision ID: 017
Revises: 016
Create Date: 2026-05-10

Backfill rule: existing rows are assigned to the FIRST existing user
(ordered by created_at ASC). On a fresh DB with no users, rows remain
NULL — they will be silently visible to API-key/dev-mode callers
(which is the same behaviour as pre-migration).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


_TABLES = ("sessions", "webhooks", "session_templates")


def upgrade() -> None:
    # 1. Add user_id FK columns (nullable for backwards-compat).
    #    NOTE: users.id uses postgresql.UUID(as_uuid=False) — we match that.
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column(
                "user_id",
                postgresql.UUID(as_uuid=False),
                nullable=True,
            ),
        )
        op.create_foreign_key(
            f"fk_{table}_user_id",
            table,
            "users",
            ["user_id"],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index(f"ix_{table}_user_id", table, ["user_id"])

    # 2. Backfill: assign existing rows to the first user (admin/founder).
    #    If no users exist yet (fresh DB), rows stay NULL — they will be
    #    treated as "all access" by the auth-aware route handlers.
    op.execute(
        """
        UPDATE sessions
        SET user_id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
        WHERE user_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE webhooks
        SET user_id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
        WHERE user_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE session_templates
        SET user_id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
        WHERE user_id IS NULL
        """
    )


def downgrade() -> None:
    for table in _TABLES:
        op.drop_index(f"ix_{table}_user_id", table_name=table)
        op.drop_constraint(f"fk_{table}_user_id", table, type_="foreignkey")
        op.drop_column(table, "user_id")
