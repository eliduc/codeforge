"""007 add code execution settings to sessions

Revision ID: 007
Revises: 006
Create Date: 2026-02-16

Add code-execution related columns to the sessions table:
  enable_code_execution, execution_timeout, max_fix_attempts, auto_install_deps
"""
from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("enable_code_execution", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "sessions",
        sa.Column("execution_timeout", sa.Integer(), nullable=False, server_default=sa.text("60")),
    )
    op.add_column(
        "sessions",
        sa.Column("max_fix_attempts", sa.Integer(), nullable=False, server_default=sa.text("3")),
    )
    op.add_column(
        "sessions",
        sa.Column("auto_install_deps", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )


def downgrade() -> None:
    op.drop_column("sessions", "auto_install_deps")
    op.drop_column("sessions", "max_fix_attempts")
    op.drop_column("sessions", "execution_timeout")
    op.drop_column("sessions", "enable_code_execution")
