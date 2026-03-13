"""Initial migration - create all tables

Revision ID: 001_initial
Revises: 
Create Date: 2024-01-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '001_initial'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create prompt_templates table first (referenced by agent_configs)
    op.create_table(
        'prompt_templates',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('agent_type', sa.String(length=20), nullable=False),
        sa.Column('template_text', sa.Text(), nullable=False),
        sa.Column('is_default', sa.Boolean(), nullable=True, default=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name')
    )

    # Create sessions table
    op.create_table(
        'sessions',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('specification', sa.Text(), nullable=False),
        sa.Column('initial_code', sa.Text(), nullable=True),
        sa.Column('initial_docs', sa.Text(), nullable=True),
        sa.Column('language', sa.String(length=50), nullable=True, default='python'),
        sa.Column('max_iterations', sa.Integer(), nullable=True, default=5),
        sa.Column('current_iteration', sa.Integer(), nullable=True, default=0),
        sa.Column('status', sa.String(length=20), nullable=True, default='created'),
        sa.Column('settings', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

    # Create agent_configs table
    op.create_table(
        'agent_configs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('agent_type', sa.String(length=20), nullable=False),
        sa.Column('agent_index', sa.Integer(), nullable=True, default=0),
        sa.Column('llm_provider', sa.String(length=50), nullable=False),
        sa.Column('llm_model', sa.String(length=100), nullable=False),
        sa.Column('prompt_template_id', sa.Integer(), nullable=True),
        sa.Column('custom_prompt', sa.Text(), nullable=True),
        sa.Column('temperature', sa.Float(), nullable=True, default=0.7),
        sa.Column('max_tokens', sa.Integer(), nullable=True, default=4096),
        sa.ForeignKeyConstraint(['prompt_template_id'], ['prompt_templates.id']),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', 'agent_type', 'agent_index', name='uq_agent_config')
    )

    # Create code_versions table
    op.create_table(
        'code_versions',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('coder_index', sa.Integer(), nullable=False),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('code_content', sa.Text(), nullable=False),
        sa.Column('file_structure', sa.JSON(), nullable=True),
        sa.Column('analysis', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=True, default='generated'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', 'coder_index', 'iteration', name='uq_code_version')
    )

    # Create audits table
    op.create_table(
        'audits',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('code_version_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('tester_index', sa.Integer(), nullable=False),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('audit_content', sa.Text(), nullable=False),
        sa.Column('overall_assessment', sa.Text(), nullable=True),
        sa.Column('specification_compliance', sa.Integer(), nullable=True),
        sa.Column('issues', sa.JSON(), nullable=True),
        sa.Column('positive_aspects', sa.JSON(), nullable=True),
        sa.Column('test_cases_needed', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['code_version_id'], ['code_versions.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', 'code_version_id', 'tester_index', name='uq_audit')
    )

    # Create summary_audits table
    op.create_table(
        'summary_audits',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('coder_index', sa.Integer(), nullable=False),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('summary_content', sa.Text(), nullable=False),
        sa.Column('critical_issues', sa.JSON(), nullable=True),
        sa.Column('serious_issues', sa.JSON(), nullable=True),
        sa.Column('minor_issues', sa.JSON(), nullable=True),
        sa.Column('suggestions', sa.JSON(), nullable=True),
        sa.Column('consensus_notes', sa.Text(), nullable=True),
        sa.Column('recommended_focus', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', 'coder_index', 'iteration', name='uq_summary_audit')
    )

    # Create coder_responses table
    op.create_table(
        'coder_responses',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('coder_index', sa.Integer(), nullable=False),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('accepted_issues', sa.JSON(), nullable=True),
        sa.Column('partial_issues', sa.JSON(), nullable=True),
        sa.Column('rejected_issues', sa.JSON(), nullable=True),
        sa.Column('rejection_reasons', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id', 'coder_index', 'iteration', name='uq_coder_response')
    )

    # Create code_executions table
    op.create_table(
        'code_executions',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('code_version_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('executor_type', sa.String(length=50), nullable=True, default='docker'),
        sa.Column('command', sa.Text(), nullable=True),
        sa.Column('exit_code', sa.Integer(), nullable=True),
        sa.Column('stdout', sa.Text(), nullable=True),
        sa.Column('stderr', sa.Text(), nullable=True),
        sa.Column('execution_time_ms', sa.Integer(), nullable=True),
        sa.Column('memory_used_mb', sa.Float(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['code_version_id'], ['code_versions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )

    # Create llm_requests table
    op.create_table(
        'llm_requests',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('agent_type', sa.String(length=20), nullable=False),
        sa.Column('agent_index', sa.Integer(), nullable=True, default=0),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('llm_provider', sa.String(length=50), nullable=False),
        sa.Column('llm_model', sa.String(length=100), nullable=False),
        sa.Column('prompt_sent', sa.Text(), nullable=False),
        sa.Column('response_received', sa.Text(), nullable=False),
        sa.Column('input_tokens', sa.Integer(), nullable=True, default=0),
        sa.Column('output_tokens', sa.Integer(), nullable=True, default=0),
        sa.Column('cost_usd', sa.Float(), nullable=True, default=0.0),
        sa.Column('latency_ms', sa.Integer(), nullable=True, default=0),
        sa.Column('success', sa.Boolean(), nullable=True, default=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )

    # Create interventions table
    op.create_table(
        'interventions',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('iteration', sa.Integer(), nullable=False),
        sa.Column('intervention_type', sa.String(length=50), nullable=False),
        sa.Column('target_agent_type', sa.String(length=20), nullable=True),
        sa.Column('target_agent_index', sa.Integer(), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('applied', sa.Boolean(), nullable=True, default=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )

    # Create final_results table
    op.create_table(
        'final_results',
        sa.Column('id', postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column('session_id', postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column('selected_coder_index', sa.Integer(), nullable=False),
        sa.Column('final_code', sa.Text(), nullable=False),
        sa.Column('file_structure', sa.JSON(), nullable=True),
        sa.Column('readme_content', sa.Text(), nullable=False),
        sa.Column('api_docs', sa.Text(), nullable=True),
        sa.Column('report_pdf_path', sa.String(length=500), nullable=True),
        sa.Column('selection_reasoning', sa.Text(), nullable=False),
        sa.Column('total_iterations', sa.Integer(), nullable=True, default=0),
        sa.Column('total_tokens', sa.Integer(), nullable=True, default=0),
        sa.Column('total_cost_usd', sa.Float(), nullable=True, default=0.0),
        sa.Column('known_limitations', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id')
    )

    # Create app_settings table
    op.create_table(
        'app_settings',
        sa.Column('key', sa.String(length=255), nullable=False),
        sa.Column('value', sa.JSON(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('key')
    )

    # Create indexes for better query performance
    op.create_index('ix_sessions_status', 'sessions', ['status'])
    op.create_index('ix_sessions_created_at', 'sessions', ['created_at'])
    op.create_index('ix_code_versions_session_iteration', 'code_versions', ['session_id', 'iteration'])
    op.create_index('ix_audits_session_iteration', 'audits', ['session_id', 'iteration'])
    op.create_index('ix_llm_requests_session', 'llm_requests', ['session_id'])


def downgrade() -> None:
    # Drop indexes
    op.drop_index('ix_llm_requests_session', table_name='llm_requests')
    op.drop_index('ix_audits_session_iteration', table_name='audits')
    op.drop_index('ix_code_versions_session_iteration', table_name='code_versions')
    op.drop_index('ix_sessions_created_at', table_name='sessions')
    op.drop_index('ix_sessions_status', table_name='sessions')

    # Drop tables in reverse order
    op.drop_table('app_settings')
    op.drop_table('final_results')
    op.drop_table('interventions')
    op.drop_table('llm_requests')
    op.drop_table('code_executions')
    op.drop_table('coder_responses')
    op.drop_table('summary_audits')
    op.drop_table('audits')
    op.drop_table('code_versions')
    op.drop_table('agent_configs')
    op.drop_table('sessions')
    op.drop_table('prompt_templates')
