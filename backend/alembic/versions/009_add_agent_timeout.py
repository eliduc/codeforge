"""009 add agent_timeout to sessions

Revision ID: 009
Revises: 008
Create Date: 2026-02-19

Add agent_timeout column to sessions table — configurable timeout (in seconds)
for LLM API calls from coder/tester agents. Defaults to 300s (5 minutes).
"""
from alembic import op
import sqlalchemy as sa

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("agent_timeout", sa.Integer(), nullable=False, server_default=sa.text("300")),
    )


def downgrade() -> None:
    op.drop_column("sessions", "agent_timeout")
