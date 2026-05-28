"""visual review: status, screenshots, scores

Revision ID: 020
Revises: 019
Create Date: 2026-05-23

Wave 1 of the Visual Review feature:

1. Adds ``awaiting_visual_review`` to the sessions.status CHECK constraint
   (drop and re-add since Postgres does not support ALTER CONSTRAINT for CHECKs).
2. Creates ``code_version_screenshots`` (N stills captured from a code version
   in headless Chromium when entering the AWAITING_VISUAL_REVIEW phase).
3. Creates ``visual_review_scores`` (user or vision-LLM scores 0-10 per
   code version, one row per (session, code_version, source)).

Reversible: downgrade narrows the CHECK back to the previous status set and
drops the two new tables. Sessions already in awaiting_visual_review (if any)
are pushed to ``paused`` first so the narrowed CHECK does not fail.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


# Status sets — kept verbatim so the SQL is auditable.
_NEW_STATUS_SET = (
    "'created', 'running', 'paused', 'completed', 'failed', "
    "'cancelled', 'awaiting_enhancement', 'enhancing', 'awaiting_enhancement_review', "
    "'awaiting_visual_review'"
)
_OLD_STATUS_SET = (
    "'created', 'running', 'paused', 'completed', 'failed', "
    "'cancelled', 'awaiting_enhancement', 'enhancing', 'awaiting_enhancement_review'"
)


def upgrade() -> None:
    # 1. Widen the CHECK constraint on sessions.status.
    op.execute("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_status_valid")
    op.execute(
        f"ALTER TABLE sessions ADD CONSTRAINT ck_sessions_status_valid "
        f"CHECK (status IN ({_NEW_STATUS_SET}))"
    )

    # 2. code_version_screenshots
    op.create_table(
        "code_version_screenshots",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "code_version_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("code_versions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("frame_index", sa.Integer(), nullable=False),
        sa.Column("t_seconds", sa.Float(), nullable=False),
        sa.Column("image_path", sa.String(length=500), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "code_version_id", "frame_index", name="uq_code_version_screenshot_frame"
        ),
    )
    op.create_index(
        "ix_code_version_screenshots_code_version_id",
        "code_version_screenshots",
        ["code_version_id"],
    )

    # 3. visual_review_scores
    op.create_table(
        "visual_review_scores",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "code_version_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("code_versions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column(
            "submitted_by",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "source",
            sa.String(length=20),
            nullable=False,
            server_default=sa.text("'user'"),
        ),
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "score >= 0 AND score <= 10",
            name="ck_visual_review_score_range",
        ),
        sa.CheckConstraint(
            "source IN ('user', 'vision_llm')",
            name="ck_visual_review_score_source",
        ),
        sa.UniqueConstraint(
            "session_id", "code_version_id", "source",
            name="uq_visual_review_score",
        ),
    )
    op.create_index(
        "ix_visual_review_scores_session_id",
        "visual_review_scores",
        ["session_id"],
    )
    op.create_index(
        "ix_visual_review_scores_code_version_id",
        "visual_review_scores",
        ["code_version_id"],
    )


def downgrade() -> None:
    # Drop indexes + tables first so the narrower CHECK doesn't fail on FKs.
    op.drop_index(
        "ix_visual_review_scores_code_version_id",
        table_name="visual_review_scores",
    )
    op.drop_index(
        "ix_visual_review_scores_session_id",
        table_name="visual_review_scores",
    )
    op.drop_table("visual_review_scores")

    op.drop_index(
        "ix_code_version_screenshots_code_version_id",
        table_name="code_version_screenshots",
    )
    op.drop_table("code_version_screenshots")

    # Move any sessions that are still in awaiting_visual_review to 'paused'
    # so narrowing the CHECK doesn't fail.
    op.execute(
        "UPDATE sessions SET status = 'paused' WHERE status = 'awaiting_visual_review'"
    )
    op.execute("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_status_valid")
    op.execute(
        f"ALTER TABLE sessions ADD CONSTRAINT ck_sessions_status_valid "
        f"CHECK (status IN ({_OLD_STATUS_SET}))"
    )
