"""013 add session templates

Revision ID: 013
Revises: 012
Create Date: 2026-05-10

Add session_templates table for storing reusable session configurations.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "session_templates",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("agent_configs", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("language", sa.String(50), nullable=False, server_default="python"),
        sa.Column("max_iterations", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("auto_continue", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("enable_code_execution", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("execution_timeout", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("max_fix_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("auto_install_deps", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("agent_timeout", sa.Integer(), nullable=False, server_default="600"),
        sa.Column("request_timeout", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("settings", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_session_templates_name", "session_templates", ["name"])


def downgrade() -> None:
    op.drop_index("ix_session_templates_name", table_name="session_templates")
    op.drop_table("session_templates")
