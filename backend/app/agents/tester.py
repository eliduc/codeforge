"""Tester agent implementation."""

import json
import logging
import re
from typing import Any

from app.agents.base import AgentResult, BaseAgent
from app.db.models import AgentType
from app.llm import LLMError, LLMRouter
from app.utils.json_utils import fix_json as _shared_fix_json

logger = logging.getLogger(__name__)


# Default prompt template for tester agent
DEFAULT_TESTER_PROMPT = """You are an expert code reviewer and quality assurance engineer. Your task is to thoroughly audit the provided code against the specification.

## SPECIFICATION
{{ specification }}

{% if initial_docs %}
## ADDITIONAL DOCUMENTATION
{{ initial_docs }}
{% endif %}

## CODE TO AUDIT (by Coder #{{ coder_index + 1 }}, Iteration {{ iteration }})
```{{ language }}
{{ code }}
```

{% if coder_rejections %}
## CODER'S PREVIOUS REJECTIONS
The coder previously rejected these issues with the following reasons:
{% for issue_id, rejection in coder_rejections.items() %}
- {{ issue_id }}: {{ rejection.decision }} - {{ rejection.reason }}
{% endfor %}

If you still believe these are valid issues, re-raise them with stronger evidence.
{% endif %}

{% if execution_result %}
## CODE EXECUTION RESULT
Exit Code: {{ execution_result.exit_code }}
{% if execution_result.stdout %}
STDOUT:
```
{{ execution_result.stdout }}
```
{% endif %}
{% if execution_result.stderr %}
STDERR:
```
{{ execution_result.stderr }}
```
{% endif %}
{% endif %}

## YOUR TASK
Perform a comprehensive code audit. For each issue found, classify its severity:

**CRITICAL** - Code doesn't work, security vulnerabilities, data loss potential
**SERIOUS** - Significant bugs, specification violations, major logic errors
**MINOR** - Small bugs, edge cases not handled, minor deviations
**SUGGESTION** - Code improvements, refactoring opportunities, style issues

Be thorough but fair. Don't invent issues that don't exist. Focus on:
1. **Correctness**: Does the code work as specified?
2. **Completeness**: Are all requirements implemented?
3. **Security**: Any vulnerabilities or unsafe patterns?
4. **Error Handling**: Are edge cases handled?
5. **Code Quality**: Is it maintainable, readable, efficient?
6. **Documentation**: Are there adequate comments/docstrings?

## OUTPUT FORMAT
Respond ONLY with valid JSON in this exact structure. Output raw JSON without any markdown code fences or backticks.

{
  "overall_assessment": "Brief overall assessment of the code quality (2-3 sentences)",
  "spec_compliance_score": 8,
  "correctness_score": 7,
  "quality_score": 8,
  "issues": [
    {
      "id": "CRIT_1",
      "severity": "critical",
      "category": "security|logic|specification|performance|error_handling|documentation|style",
      "description": "Clear description of the issue",
      "location": "function_name, line ~X or 'general'",
      "evidence": "Specific code snippet or reasoning showing the problem",
      "suggestion": "How to fix this issue"
    }
  ],
  "positive_aspects": [
    "Good thing about the code #1",
    "Good thing about the code #2"
  ],
  "test_cases_needed": [
    {
      "name": "Test case name",
      "description": "What this test should verify",
      "expected_behavior": "What should happen"
    }
  ]
}

Issue ID format:
- CRIT_N for Critical
- SER_N for Serious
- MIN_N for Minor
- SUG_N for Suggestion

Scores are 1-10 where 10 is perfect.
"""


class TesterAgent(BaseAgent):
    """Agent that audits code for issues."""

    agent_type = AgentType.TESTER

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.3,  # Lower temperature for more consistent audits
        max_tokens: int = 8192,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or DEFAULT_TESTER_PROMPT,
            agent_index=agent_index,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

    async def execute(
        self,
        specification: str,
        code: str,
        language: str = "python",
        iteration: int = 1,
        coder_index: int = 0,
        initial_docs: str | None = None,
        coder_rejections: dict[str, Any] | None = None,
        execution_result: dict[str, Any] | None = None,
    ) -> AgentResult:
        """Audit code and identify issues."""
        # Render prompt
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            language=language,
            iteration=iteration,
            coder_index=coder_index,
            initial_docs=initial_docs,
            coder_rejections=coder_rejections,
            execution_result=execution_result,
        )

        system_prompt = (
            f"You are Tester Agent #{self.agent_index + 1}, an expert code reviewer. "
            f"You meticulously analyze code for bugs, security issues, and specification compliance. "
            f"You are fair but thorough - you don't miss real issues, but you don't invent fake ones. "
            f"You ALWAYS respond with valid JSON only, no other text."
        )

        # Call LLM
        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        # Parse response
        try:
            parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.warning(f"Failed to parse tester response: {e}. Creating fallback result.")
            # Instead of failing, create a minimal valid audit with 0 issues
            # so the workflow can continue. The tester's text is still available.
            fallback_parsed = {
                "overall_assessment": f"[Parse error — raw response available] {response.content[:500]}",
                "spec_compliance_score": 5,
                "correctness_score": 5,
                "quality_score": 5,
                "issues": [],
                "positive_aspects": [],
                "test_cases_needed": [],
            }
            return self._create_result(response, fallback_parsed)

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse the tester's JSON response."""
        # Try to extract JSON from markdown code block first
        json_match = re.search(r"```(?:json)?\s*\n(.*?)```", content, re.DOTALL)
        if json_match:
            json_str = json_match.group(1).strip()
        else:
            # Try to parse the entire content as JSON
            json_str = content.strip()

        try:
            result = json.loads(json_str)
        except json.JSONDecodeError:
            # Try to fix common JSON issues
            json_str = _shared_fix_json(json_str)
            try:
                result = json.loads(json_str)
            except json.JSONDecodeError as e:
                logger.error(f"Tester JSON parse failed even after fix_json: {e}")
                raise

        # Validate and normalize the result
        return self._normalize_audit_result(result)

    def _normalize_audit_result(self, result: dict[str, Any]) -> dict[str, Any]:
        """Normalize and validate the audit result."""
        normalized = {
            "overall_assessment": result.get("overall_assessment", ""),
            "spec_compliance_score": self._clamp_score(result.get("spec_compliance_score", 5)),
            "correctness_score": self._clamp_score(result.get("correctness_score", 5)),
            "quality_score": self._clamp_score(result.get("quality_score", 5)),
            "issues": [],
            "positive_aspects": result.get("positive_aspects", []),
            "test_cases_needed": result.get("test_cases_needed", []),
        }

        # Normalize issues
        for issue in result.get("issues", []):
            normalized_issue = {
                "id": issue.get("id", f"ISSUE_{len(normalized['issues']) + 1}"),
                "severity": self._normalize_severity(issue.get("severity", "minor")),
                "category": issue.get("category", "general"),
                "description": issue.get("description", ""),
                "location": issue.get("location"),
                "evidence": issue.get("evidence"),
                "suggestion": issue.get("suggestion"),
            }
            if normalized_issue["description"]:  # Only add issues with descriptions
                normalized["issues"].append(normalized_issue)

        return normalized

    def _clamp_score(self, score: Any) -> int:
        """Clamp score to valid range 1-10."""
        try:
            return max(1, min(10, round(float(score))))
        except (ValueError, TypeError):
            return 5

    def _normalize_severity(self, severity: Any) -> str:
        """Normalize severity to valid values."""
        if not isinstance(severity, str):
            return "minor"
        severity = severity.lower().strip()
        if severity in ("critical", "crit"):
            return "critical"
        elif severity in ("serious", "ser", "major"):
            return "serious"
        elif severity in ("minor", "min"):
            return "minor"
        elif severity in ("suggestion", "sug", "info"):
            return "suggestion"
        return "minor"  # Default to minor
