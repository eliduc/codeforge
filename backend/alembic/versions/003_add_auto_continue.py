"""Add auto_continue field to sessions

Revision ID: 003
Revises: 002
Create Date: 2026-02-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '003_add_auto_continue'
down_revision: Union[str, None] = '002_seed_prompts'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add auto_continue column with default True
    op.add_column('sessions', sa.Column('auto_continue', sa.Boolean(), nullable=False, server_default='true'))


def downgrade() -> None:
    op.drop_column('sessions', 'auto_continue')
