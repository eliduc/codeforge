"""КАО#R4-C2 — backfill columns that exist in the ORM models but were never
added by any migration (schema drift dating to the initial commit):
agent_configs.enabled and final_results.verification_*.

Fresh DBs provisioned via `alembic upgrade head` (the shipped docker-compose
startup path) were missing these columns, so session create/load 500'd with
UndefinedColumn. Existing stage/prod DBs were bootstrapped via create_all and
already have the columns — hence ADD COLUMN IF NOT EXISTS, which is a no-op
there and a fix on alembic-provisioned DBs.

Revision ID: 023
Revises: 022
"""
from alembic import op

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agent_configs "
        "ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true"
    )
    op.execute("ALTER TABLE final_results ADD COLUMN IF NOT EXISTS verification_passed BOOLEAN")
    op.execute("ALTER TABLE final_results ADD COLUMN IF NOT EXISTS verification_exit_code INTEGER")
    op.execute("ALTER TABLE final_results ADD COLUMN IF NOT EXISTS verification_stdout TEXT")
    op.execute("ALTER TABLE final_results ADD COLUMN IF NOT EXISTS verification_stderr TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE final_results DROP COLUMN IF EXISTS verification_stderr")
    op.execute("ALTER TABLE final_results DROP COLUMN IF EXISTS verification_stdout")
    op.execute("ALTER TABLE final_results DROP COLUMN IF EXISTS verification_exit_code")
    op.execute("ALTER TABLE final_results DROP COLUMN IF EXISTS verification_passed")
    op.execute("ALTER TABLE agent_configs DROP COLUMN IF EXISTS enabled")
