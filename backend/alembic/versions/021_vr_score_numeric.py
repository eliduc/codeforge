"""visual_review_scores.score: int → numeric(3,1) for half-step scoring

Revision ID: 021
Revises: 020
Create Date: 2026-05-24

КАО#VR-27. The frontend slider uses ``step={0.5}`` (so the user can pick
``7.5``, ``8.5``, etc.) but the original schema/DB column was ``Integer``,
causing Pydantic 422 ValidationError on submit and silently blocking the
Submit-ranking button.

Fix: widen the DB column to ``Numeric(3, 1)`` (0.0..10.0 with one decimal,
fits exactly), recreate the CHECK constraint (Postgres drops it when the
column type changes), and load existing integer rows as floats with ``.0``.

Reversible: downgrade rounds every fractional row to the nearest integer
before narrowing the column back to ``Integer`` (lossy, but explicit — we'd
rather lose precision than silently fail the downgrade).
"""
from alembic import op
import sqlalchemy as sa


revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Drop the check constraint (it references the column type).
    op.drop_constraint(
        "ck_visual_review_score_range",
        "visual_review_scores",
        type_="check",
    )
    # 2. Widen the column. USING ensures the cast is explicit; integer → numeric
    #    is loss-free.
    op.alter_column(
        "visual_review_scores",
        "score",
        existing_type=sa.Integer(),
        type_=sa.Numeric(3, 1),
        postgresql_using="score::numeric(3,1)",
        existing_nullable=False,
    )
    # 3. Re-add the same logical constraint on the new column type.
    op.create_check_constraint(
        "ck_visual_review_score_range",
        "visual_review_scores",
        "score >= 0 AND score <= 10",
    )


def downgrade() -> None:
    # Round fractional values before narrowing — would otherwise fail on rows
    # like 7.5. Trade-off: information loss vs. an irreversible upgrade. We
    # choose loss because it's recoverable from logs, while a failed downgrade
    # blocks rollback entirely.
    op.execute(
        "UPDATE visual_review_scores SET score = ROUND(score)::integer "
        "WHERE score IS NOT NULL"
    )
    op.drop_constraint(
        "ck_visual_review_score_range",
        "visual_review_scores",
        type_="check",
    )
    op.alter_column(
        "visual_review_scores",
        "score",
        existing_type=sa.Numeric(3, 1),
        type_=sa.Integer(),
        postgresql_using="score::integer",
        existing_nullable=False,
    )
    op.create_check_constraint(
        "ck_visual_review_score_range",
        "visual_review_scores",
        "score >= 0 AND score <= 10",
    )
