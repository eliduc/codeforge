"""006 widen session status column

Revision ID: 006
Revises: 005
Create Date: 2026-02-15

Widen sessions.status from String(20) to String(50)
to support new enhancement workflow statuses:
  awaiting_enhancement, enhancing, awaiting_enhancement_review
"""
from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005_add_enhancement"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "sessions",
        "status",
        type_=sa.String(50),
        existing_type=sa.String(20),
    )


def downgrade() -> None:
    # Truncate or map status values longer than 20 chars before narrowing the column
    op.execute(
        sa.text(
            "UPDATE sessions SET status = LEFT(status, 20) WHERE LENGTH(status) > 20"
        )
    )
    op.alter_column(
        "sessions",
        "status",
        type_=sa.String(20),
        existing_type=sa.String(50),
    )
