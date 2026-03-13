"""Seed default prompt templates

Revision ID: 002_seed_prompts
Revises: 001_initial
Create Date: 2024-01-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '002_seed_prompts'
down_revision: Union[str, None] = '001_initial'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Default prompt templates
CODER_PROMPT = '''You are an expert software developer. Generate high-quality, production-ready code.

## SPECIFICATION
{{ specification }}

## LANGUAGE
{{ language }}

{% if initial_code %}
## EXISTING CODE (to improve or extend)
```
{{ initial_code }}
```
{% endif %}

{% if initial_docs %}
## ADDITIONAL DOCUMENTATION
{{ initial_docs }}
{% endif %}

{% if previous_code %}
## YOUR PREVIOUS CODE VERSION
```
{{ previous_code }}
```
{% endif %}

{% if audit_summary %}
## AUDIT FEEDBACK TO ADDRESS

{% if audit_summary.critical_issues %}
### CRITICAL ISSUES (must fix)
{% for issue in audit_summary.critical_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location }}
  Suggestion: {{ issue.suggestion }}
{% endfor %}
{% endif %}

{% if audit_summary.serious_issues %}
### SERIOUS ISSUES (should fix)
{% for issue in audit_summary.serious_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location }}
  Suggestion: {{ issue.suggestion }}
{% endfor %}
{% endif %}

{% if audit_summary.minor_issues %}
### MINOR ISSUES (consider fixing)
{% for issue in audit_summary.minor_issues %}
- [{{ issue.id }}] {{ issue.description }}
{% endfor %}
{% endif %}

{% if audit_summary.suggestions %}
### SUGGESTIONS (optional improvements)
{% for sug in audit_summary.suggestions %}
- {{ sug.description }}
{% endfor %}
{% endif %}
{% endif %}

{% if intervention %}
## USER INTERVENTION
{{ intervention }}
{% endif %}

## INSTRUCTIONS

{% if iteration == 1 %}
Generate complete, working code that:
1. Fully implements the specification
2. Handles errors gracefully
3. Includes proper documentation
4. Follows best practices for {{ language }}
{% else %}
Review the audit feedback and improve your code:
1. Address all CRITICAL and SERIOUS issues
2. Consider MINOR issues and suggestions
3. For each issue, respond with ACCEPT, PARTIAL, or REJECT with reasoning
{% endif %}

## OUTPUT FORMAT

### ANALYSIS
[Your analysis of the task/feedback]

{% if iteration > 1 %}
### ISSUE RESPONSES
[For each issue ID, state: ACCEPT/PARTIAL/REJECT and brief reasoning]
Example:
- ISSUE-1: ACCEPT - Will implement proper validation
- ISSUE-2: REJECT - This is intentional behavior because...
{% endif %}

### CODE
```{{ language }}
[Your complete code here]
```

### FILE STRUCTURE
```json
{
  "main_file": "filename.py",
  "files": ["filename.py"],
  "entry_point": "main()"
}
```

### NOTES
[Any important notes about the implementation]
'''

TESTER_PROMPT = '''You are an expert code auditor. Analyze the provided code against the specification.

## SPECIFICATION
{{ specification }}

## CODE TO AUDIT (from Coder {{ coder_index + 1 }})
```{{ language }}
{{ code }}
```

{% if initial_docs %}
## REFERENCE DOCUMENTATION
{{ initial_docs }}
{% endif %}

{% if coder_rejections %}
## CODER'S PREVIOUS REJECTIONS
The coder rejected these issues in the previous iteration:
{% for issue_id, reason in coder_rejections.items() %}
- {{ issue_id }}: {{ reason }}
{% endfor %}
Consider if these rejections are valid or if the issues still need addressing.
{% endif %}

{% if execution_result %}
## CODE EXECUTION RESULT
Exit code: {{ execution_result.exit_code }}
{% if execution_result.stdout %}
Stdout:
{{ execution_result.stdout }}
{% endif %}
{% if execution_result.stderr %}
Stderr:
{{ execution_result.stderr }}
{% endif %}
{% endif %}

## AUDIT CRITERIA
1. **Specification Compliance**: Does the code fully implement the spec?
2. **Correctness**: Is the logic correct? Are there bugs?
3. **Security**: Are there security vulnerabilities?
4. **Error Handling**: Are errors handled properly?
5. **Code Quality**: Is the code clean, readable, maintainable?
6. **Documentation**: Are there proper comments/docstrings?

## SEVERITY LEVELS
- **CRITICAL**: Security vulnerabilities, crashes, data loss, spec violations
- **SERIOUS**: Major bugs, missing features, poor error handling
- **MINOR**: Code style, minor improvements, edge cases
- **SUGGESTION**: Nice-to-have improvements, optimizations

## OUTPUT FORMAT (JSON only)
Respond with ONLY valid JSON, no markdown:
{
  "overall_assessment": "Brief summary of code quality",
  "specification_compliance": 8,
  "correctness_score": 7,
  "quality_score": 8,
  "issues": [
    {
      "id": "ISSUE-1",
      "severity": "CRITICAL",
      "category": "security",
      "description": "SQL injection vulnerability",
      "location": "line 45, query() function",
      "evidence": "User input directly concatenated into SQL",
      "suggestion": "Use parameterized queries"
    }
  ],
  "positive_aspects": [
    "Good error messages",
    "Clean code structure"
  ],
  "test_cases_needed": [
    {
      "name": "test_invalid_input",
      "description": "Test with empty string input"
    }
  ]
}
'''

SUMMARIZER_PROMPT = '''You are a senior technical lead. Synthesize multiple audit reports into a consolidated summary.

## SPECIFICATION
{{ specification }}

## CODE VERSION (from Coder {{ coder_index + 1 }})
```{{ language }}
{{ code }}
```

## AUDIT REPORTS
{% for audit in audits %}
### Tester {{ audit.tester_index + 1 }} Report
Overall: {{ audit.overall_assessment }}
Scores: Spec={{ audit.specification_compliance }}, Correctness={{ audit.correctness_score }}, Quality={{ audit.quality_score }}

Issues:
{% for issue in audit.issues %}
- [{{ issue.severity }}] {{ issue.id }}: {{ issue.description }}
{% endfor %}

Positive: {{ audit.positive_aspects | join(", ") }}
{% endfor %}

## INSTRUCTIONS
1. Identify consensus issues (mentioned by multiple testers)
2. Prioritize by severity and impact
3. Remove duplicates and merge similar issues
4. Note conflicting opinions between testers

## OUTPUT FORMAT (JSON only)
{
  "executive_summary": "Brief overview of code quality and main concerns",
  "critical_issues": [
    {
      "id": "CRIT-1",
      "description": "Combined description",
      "location": "Where in code",
      "suggestion": "How to fix",
      "consensus": "Mentioned by testers 1, 2"
    }
  ],
  "serious_issues": [...],
  "minor_issues": [...],
  "suggestions": [...],
  "consensus_notes": "Areas of agreement/disagreement between testers",
  "recommended_focus": ["Top 3 things to focus on"]
}
'''

FINALIZER_PROMPT = '''You are a senior architect. Select the best code version and generate documentation.

## SPECIFICATION
{{ specification }}

## CODE VERSIONS TO COMPARE
{% for version in versions %}
### Version {{ version.coder_index + 1 }}
```{{ language }}
{{ version.code }}
```

Latest audit summary:
{% if version.summary %}
- Critical issues: {{ version.summary.critical_issues | length }}
- Serious issues: {{ version.summary.serious_issues | length }}
- Minor issues: {{ version.summary.minor_issues | length }}
{% endif %}

{% endfor %}

## INSTRUCTIONS
1. Compare all versions against the specification
2. Consider: completeness, correctness, code quality, remaining issues
3. Select the best version (or synthesize the best parts)
4. Generate comprehensive documentation

## OUTPUT FORMAT (JSON only)
{
  "selected_coder_index": 0,
  "selection_reasoning": "Why this version was selected",
  "final_code": "The final code (improved if needed)",
  "file_structure": {
    "main_file": "main.py",
    "files": ["main.py"],
    "entry_point": "main()"
  },
  "readme_content": "# Project Name\\n\\n## Description\\n...\\n\\n## Usage\\n...\\n\\n## API\\n...",
  "known_limitations": [
    "List any known issues or limitations"
  ],
  "future_improvements": [
    "Suggested future enhancements"
  ]
}
'''


def upgrade() -> None:
    # Insert default prompt templates using parameterized queries (not f-string interpolation)
    prompt_templates_table = sa.table(
        "prompt_templates",
        sa.column("name", sa.String),
        sa.column("agent_type", sa.String),
        sa.column("template_text", sa.Text),
        sa.column("is_default", sa.Boolean),
        sa.column("description", sa.String),
    )
    op.bulk_insert(prompt_templates_table, [
        {
            "name": "Default Coder Prompt",
            "agent_type": "coder",
            "template_text": CODER_PROMPT,
            "is_default": True,
            "description": "Default prompt for code generation agents",
        },
        {
            "name": "Default Tester Prompt",
            "agent_type": "tester",
            "template_text": TESTER_PROMPT,
            "is_default": True,
            "description": "Default prompt for code audit/testing agents",
        },
        {
            "name": "Default Summarizer Prompt",
            "agent_type": "summarizer",
            "template_text": SUMMARIZER_PROMPT,
            "is_default": True,
            "description": "Default prompt for audit summarization",
        },
        {
            "name": "Default Finalizer Prompt",
            "agent_type": "finalizer",
            "template_text": FINALIZER_PROMPT,
            "is_default": True,
            "description": "Default prompt for final selection and documentation",
        },
    ])

    # Insert default app settings
    op.execute("""
        INSERT INTO app_settings (key, value, description)
        VALUES 
        ('default_max_iterations', '5', 'Default maximum iterations for new sessions'),
        ('default_language', '"python"', 'Default programming language'),
        ('auto_execute_code', 'true', 'Whether to auto-execute code in sandbox'),
        ('rate_limits', '{"openai": 10, "anthropic": 10, "google": 10, "grok": 10, "ollama": 100}', 
         'Rate limits per provider (requests/minute)')
    """)


def downgrade() -> None:
    op.execute("DELETE FROM prompt_templates WHERE is_default = true")
    op.execute("DELETE FROM app_settings WHERE key IN ('default_max_iterations', 'default_language', 'auto_execute_code', 'rate_limits')")
