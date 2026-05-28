"""cost guard, session time budget, and test-driven mode columns

Revision ID: 018
Revises: 017
Create Date: 2026-05-10

Adds three nullable columns to ``sessions``:
- ``cost_limit_usd`` (Numeric(10, 2)): hard cost cap; orchestrator stops when exceeded
- ``session_timeout_sec`` (Integer): wall-clock budget for the entire workflow
- ``expected_output`` (Text): expected stdout for test-driven mode

All columns are nullable; existing sessions remain unconstrained.
"""
from alembic import op
import sqlalchemy as sa


revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("cost_limit_usd", sa.Numeric(10, 2), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("session_timeout_sec", sa.Integer(), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("expected_output", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "expected_output")
    op.drop_column("sessions", "session_timeout_sec")
    op.drop_column("sessions", "cost_limit_usd")
