"""008 add thinking_effort to agent_configs

Revision ID: 008
Revises: 007
Create Date: 2026-02-18

Add thinking_effort column to agent_configs table.
Values: low, medium, high, max, or NULL (provider default).
"""
from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_configs",
        sa.Column("thinking_effort", sa.String(20), nullable=True, default=None),
    )


def downgrade() -> None:
    op.drop_column("agent_configs", "thinking_effort")
