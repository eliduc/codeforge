"""add workflow checkpoints

Revision ID: 016
Revises: 015
Create Date: 2026-05-10

Adds workflow_checkpoints table for crash recovery — snapshot of
WorkflowState saved at iteration boundaries.
"""
from alembic import op
import sqlalchemy as sa


revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_checkpoints",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "session_id",
            sa.dialects.postgresql.UUID(as_uuid=False),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("iteration", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=50), nullable=False),
        sa.Column("state_json", sa.JSON(), nullable=False),
        sa.Column(
            "total_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "total_cost_usd",
            sa.Numeric(precision=12, scale=6),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "session_id", "iteration", "phase", name="uq_checkpoint"
        ),
    )
    op.create_index(
        "ix_workflow_checkpoints_session_id",
        "workflow_checkpoints",
        ["session_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_workflow_checkpoints_session_id",
        table_name="workflow_checkpoints",
    )
    op.drop_table("workflow_checkpoints")
