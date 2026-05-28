"""012 add request_timeout to sessions

Revision ID: 012
Revises: 011
Create Date: 2026-03-15

Add request_timeout column to sessions table — configurable httpx timeout
(in seconds) for individual LLM API requests. Must be <= agent_timeout.
Defaults to 300s.
"""
from alembic import op
import sqlalchemy as sa

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("request_timeout", sa.Integer(), nullable=False, server_default=sa.text("300")),
    )
    # Update agent_timeout default from 300 to 600 for new sessions
    op.alter_column("sessions", "agent_timeout", server_default=sa.text("600"))


def downgrade() -> None:
    op.drop_column("sessions", "request_timeout")
