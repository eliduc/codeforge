"""add prompt template versions

Revision ID: 015
Revises: 014
Create Date: 2026-05-10

Adds current_version column to prompt_templates and a new
prompt_template_versions history table for rollback support.
"""
from alembic import op
import sqlalchemy as sa


revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "prompt_templates",
        sa.Column("current_version", sa.Integer(), nullable=False, server_default="1"),
    )

    op.create_table(
        "prompt_template_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "template_id",
            sa.Integer(),
            sa.ForeignKey("prompt_templates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("agent_type", sa.String(length=50), nullable=False),
        sa.Column("template_text", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("change_note", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "template_id", "version_number", name="uq_prompt_template_version"
        ),
    )
    op.create_index(
        "ix_prompt_template_versions_template_id",
        "prompt_template_versions",
        ["template_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_prompt_template_versions_template_id",
        table_name="prompt_template_versions",
    )
    op.drop_table("prompt_template_versions")
    op.drop_column("prompt_templates", "current_version")
