"""005 add enhancement

Revision ID: 005
Revises: 004
Create Date: 2026-02-15

Add enhancement support:
- enhancement_suggestions table
- parent_session_id and enhancement_round columns on sessions
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "005_add_enhancement"
down_revision = "004_add_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add enhancement chain columns to sessions
    op.add_column("sessions", sa.Column("parent_session_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True))
    op.add_column("sessions", sa.Column("enhancement_round", sa.Integer(), nullable=False, server_default="0"))

    # Create enhancement_suggestions table
    op.create_table(
        "enhancement_suggestions",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("session_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_type", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("user_recommendations", sa.Text(), nullable=True),
        sa.Column("llm_provider", sa.String(50), nullable=False),
        sa.Column("llm_model", sa.String(100), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("enhancement_suggestions")
    op.drop_column("sessions", "enhancement_round")
    op.drop_column("sessions", "parent_session_id")
