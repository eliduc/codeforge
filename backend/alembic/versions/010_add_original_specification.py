"""010 add original_specification to sessions

Revision ID: 010
Revises: 009
Create Date: 2026-02-20

Add original_specification column to sessions table — stores the clean
specification as it was at session creation, so that reset can restore it
after enhancement text has been appended.
"""
from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("original_specification", sa.Text(), nullable=True),
    )
    # Backfill: set original_specification = specification for all existing sessions
    op.execute("UPDATE sessions SET original_specification = specification")


def downgrade() -> None:
    op.drop_column("sessions", "original_specification")
