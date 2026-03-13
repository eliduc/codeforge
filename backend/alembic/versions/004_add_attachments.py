"""Add attachments field to sessions

Revision ID: 004_add_attachments
Revises: 003_add_auto_continue
Create Date: 2026-02-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '004_add_attachments'
down_revision: Union[str, None] = '003_add_auto_continue'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('sessions', sa.Column('attachments', sa.JSON(), nullable=True, server_default='[]'))


def downgrade() -> None:
    op.drop_column('sessions', 'attachments')
