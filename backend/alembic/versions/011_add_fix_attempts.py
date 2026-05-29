"""011 add fix_attempts to code_versions

Revision ID: 011
Revises: 010
Create Date: 2026-05-29

VR-47 — persist the number of run→fix attempts the sandbox executor performed
for each code version, so the Coder node can show a "clean after N runs" /
"hit the fix limit" badge even on a reloaded, finished session (the live WS
events that carry the attempt count are long gone by then).

Additive + backfilled to 0; safe to run on a live DB.
"""
from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "code_versions",
        sa.Column("fix_attempts", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("code_versions", "fix_attempts")
