"""add share_token to sessions for public read-only share links

Revision ID: 019
Revises: 018
Create Date: 2026-05-10

Adds ``share_token`` (nullable, unique) to ``sessions`` so a session owner
can mint a public read-only URL via POST /api/sessions/{id}/share.
"""
from alembic import op
import sqlalchemy as sa


revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("share_token", sa.String(64), nullable=True),
    )
    op.create_index(
        "ix_sessions_share_token",
        "sessions",
        ["share_token"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_share_token", table_name="sessions")
    op.drop_column("sessions", "share_token")
