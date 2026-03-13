"""Summarizer agent implementation - aggregates audits from multiple testers."""

import json
import logging
import re
from collections import defaultdict
from typing import Any

from app.agents.base import AgentResult, BaseAgent
from app.db.models import AgentType
from app.llm import LLMError, LLMRouter
from app.utils.json_utils import fix_json as _shared_fix_json

logger = logging.getLogger(__name__)


# Default prompt template for summarizer agent
DEFAULT_SUMMARIZER_PROMPT = """You are an expert code review coordinator. Your task is to synthesize multiple audit reports into a single, actionable summary for the coder.

## SPECIFICATION
{{ specification }}

## CODE BEING REVIEWED
```{{ language }}
{{ code }}
```

## AUDIT REPORTS FROM TESTERS
{% for audit in audits %}
### Tester {{ audit.tester_index + 1 }} Report
**Overall Assessment:** {{ audit.overall_assessment or 'N/A' }}
**Spec Compliance Score:** {{ audit.spec_compliance or 'N/A' }}/10
**Correctness Score:** {{ audit.correctness or 'N/A' }}/10
**Code Quality Score:** {{ audit.quality or 'N/A' }}/10

**Issues Found:**
{% for issue in audit.issues %}
- [{{ issue.severity }}] {{ issue.id }}: {{ issue.description }}
  - Location: {{ issue.location or 'N/A' }}
  - Category: {{ issue.category or 'N/A' }}
  - Suggestion: {{ issue.suggestion or 'N/A' }}
{% endfor %}
{% if not audit.issues %}No issues found{% endif %}

**Positive Aspects:**
{% for aspect in audit.positive_aspects %}
- {{ aspect }}
{% endfor %}
{% if not audit.positive_aspects %}None mentioned{% endif %}

---
{% endfor %}

## YOUR TASK
Synthesize these audit reports into a unified summary:

1. **Identify Consensus**: Find issues mentioned by multiple testers (higher confidence)
2. **Categorize by Severity**: Group issues into CRITICAL, SERIOUS, MINOR, SUGGESTION
3. **Remove Duplicates**: Merge similar issues, noting agreement level
4. **Prioritize**: Rank issues by importance and consensus
5. **Note Conflicts**: If testers disagree, explain the disagreement
6. **Preserve Context**: Keep evidence and suggestions from the audits

## OUTPUT FORMAT
Respond with a JSON object (and ONLY JSON, no markdown). Output raw JSON without any markdown code fences, backticks, or surrounding text.

## CONTEXT
You are reviewing code from Coder #{{ coder_index + 1 }}, Iteration {{ iteration }}.

{
    "overall_assessment": "Brief 2-3 sentence summary of code quality",
    "average_scores": {
        "spec_compliance": 7.5,
        "correctness": 8.0,
        "quality": 7.0
    },
    "critical_issues": [
        {
            "id": "CRIT_1",
            "description": "Description of the issue",
            "location": "file/function/line if known",
            "category": "security|logic|spec_violation|performance|other",
            "suggestion": "How to fix",
            "agreement": "all|majority|single",
            "reported_by": [0, 1, 2]
        }
    ],
    "serious_issues": [...],
    "minor_issues": [...],
    "suggestions": [...],
    "positive_aspects": [
        "Aspect with consensus"
    ],
    "conflicts": [
        {
            "topic": "What testers disagreed about",
            "positions": {
                "tester_0": "Their view",
                "tester_1": "Their view"
            }
        }
    ],
    "consensus_notes": "Summary of overall tester agreement/disagreement",
    "recommended_focus": ["Issue IDs to prioritize fixing"]
}
"""


class SummarizerAgent(BaseAgent):
    """Agent that summarizes audits from multiple testers."""

    agent_type = AgentType.SUMMARIZER

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.3,  # Lower temperature for consistent analysis
        max_tokens: int = 8192,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or DEFAULT_SUMMARIZER_PROMPT,
            agent_index=agent_index,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

    async def execute(
        self,
        specification: str,
        code: str,
        audits: list[dict[str, Any]],
        language: str = "python",
        coder_index: int = 0,
        iteration: int = 0,
    ) -> AgentResult:
        """
        Summarize multiple audit reports into a unified summary.

        Args:
            specification: The code specification
            code: The code being audited
            audits: List of audit results from testers
            language: Programming language
            coder_index: Index of the coder (for multi-coder support)
            iteration: Current iteration number
        """
        # Pre-process audits if needed
        processed_audits = self._preprocess_audits(audits)

        # Normalize language for code fence labels
        lang_map = {
            'javascript_browser': 'html',
            'typescript_browser': 'html',
        }
        fence_language = lang_map.get(language, language)

        # Render prompt
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            audits=processed_audits,
            language=fence_language,
            coder_index=coder_index,
            iteration=iteration,
        )

        system_prompt = (
            "You are an expert code review coordinator. "
            "You synthesize multiple audit reports into clear, actionable summaries. "
            "You identify consensus, resolve conflicts, and prioritize issues effectively. "
            "Always respond with valid JSON only."
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
            logger.error(f"Failed to parse summarizer response: {e}")
            # Try to create a basic summary from raw audits
            fallback = self._create_fallback_summary(audits)
            return AgentResult(
                success=True,
                content=response.content,
                parsed_data=fallback,
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                cost_usd=self.llm_router.calculate_cost(
                    self.provider, self.model, response.input_tokens, response.output_tokens
                ),
                latency_ms=response.latency_ms,
                raw_response=response.raw_response,
            )

    def _preprocess_audits(self, audits: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Preprocess audits for better prompt rendering."""
        processed = []
        for i, audit in enumerate(audits):
            processed.append({
                "tester_index": audit.get("tester_index", i),
                "overall_assessment": audit.get("overall_assessment", ""),
                "spec_compliance": audit.get("spec_compliance_score") if audit.get("spec_compliance_score") is not None else audit.get("spec_compliance"),
                "correctness": audit.get("correctness_score") if audit.get("correctness_score") is not None else audit.get("correctness"),
                "quality": audit.get("quality_score") if audit.get("quality_score") is not None else audit.get("quality"),
                "issues": audit.get("issues", []),
                "positive_aspects": audit.get("positive_aspects", []),
            })
        return processed

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse the summarizer's JSON response."""
        # Try to parse as JSON directly
        try:
            return self._parse_and_validate(content)
        except json.JSONDecodeError:
            pass

        # Try to extract JSON from markdown code block
        json_match = re.search(r"```(?:json)?\s*\n(.*?)```", content, re.DOTALL)
        if json_match:
            try:
                return self._parse_and_validate(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find JSON object in content using brace-balanced extraction
        brace_start = content.find("{")
        if brace_start >= 0:
            depth = 0
            in_string = False
            for i in range(brace_start, len(content)):
                ch = content[i]
                if in_string:
                    if ch == '"' and (i == 0 or content[i - 1] != '\\'):
                        in_string = False
                else:
                    if ch == '"':
                        in_string = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            try:
                                return self._parse_and_validate(content[brace_start:i + 1])
                            except json.JSONDecodeError:
                                pass
                            break

        raise ValueError("Could not parse JSON from summarizer response")

    def _parse_and_validate(self, json_str: str) -> dict[str, Any]:
        """Parse JSON and validate/normalize the structure."""
        # Fix common JSON issues
        json_str = _shared_fix_json(json_str)
        data = json.loads(json_str)

        # Ensure required fields exist
        result = {
            "overall_assessment": data.get("overall_assessment", ""),
            "average_scores": data.get("average_scores", {}),
            "critical_issues": self._normalize_issues(data.get("critical_issues", [])),
            "serious_issues": self._normalize_issues(data.get("serious_issues", [])),
            "minor_issues": self._normalize_issues(data.get("minor_issues", [])),
            "suggestions": self._normalize_issues(data.get("suggestions", [])),
            "positive_aspects": data.get("positive_aspects", []),
            "conflicts": data.get("conflicts", []),
            "consensus_notes": data.get("consensus_notes", ""),
            "recommended_focus": data.get("recommended_focus", []),
        }

        return result

    def _normalize_issues(self, issues: list) -> list[dict[str, Any]]:
        """Normalize issue format."""
        normalized = []
        for issue in issues:
            if isinstance(issue, dict):
                normalized.append({
                    "id": issue.get("id", f"ISSUE_{len(normalized)+1}"),
                    "description": issue.get("description", ""),
                    "location": issue.get("location"),
                    "category": issue.get("category"),
                    "suggestion": issue.get("suggestion"),
                    "agreement": issue.get("agreement", "single"),
                    "reported_by": issue.get("reported_by", []),
                })
            elif isinstance(issue, str):
                normalized.append({
                    "id": f"ISSUE_{len(normalized)+1}",
                    "description": issue,
                    "agreement": "single",
                })
        return normalized

    @staticmethod
    def _deduplicate(items: list) -> list:
        """Deduplicate a list, falling back to the original if items are unhashable."""
        try:
            return list(set(items))
        except TypeError:
            seen: list = []
            for item in items:
                if item not in seen:
                    seen.append(item)
            return seen

    def _create_fallback_summary(self, audits: list[dict[str, Any]]) -> dict[str, Any]:
        """Create a basic summary when LLM parsing fails."""
        # Aggregate issues by severity
        issues_by_severity: dict[str, list] = defaultdict(list)
        all_positive = []
        score_keys = {
            "spec_compliance": ["spec_compliance_score", "spec_compliance"],
            "correctness": ["correctness_score", "correctness"],
            "quality": ["quality_score", "quality"],
        }
        scores: dict[str, list] = {k: [] for k in score_keys}

        for audit in audits:
            tester_idx = audit.get("tester_index", 0)

            # Collect scores (try _score suffix first, then bare name)
            for canonical, candidates in score_keys.items():
                for candidate in candidates:
                    val = audit.get(candidate)
                    if val is not None:
                        scores[canonical].append(val)
                        break

            # Collect issues
            for issue in audit.get("issues", []):
                severity = issue.get("severity", "MINOR").upper()
                issues_by_severity[severity].append({
                    **issue,
                    "reported_by": [tester_idx],
                })

            # Collect positive aspects
            all_positive.extend(audit.get("positive_aspects", []))

        # Calculate average scores
        avg_scores = {}
        for key, vals in scores.items():
            if vals:
                avg_scores[key] = round(sum(vals) / len(vals), 1)

        return {
            "overall_assessment": "Summary generated from raw audit data (LLM parsing failed)",
            "average_scores": avg_scores,
            "critical_issues": issues_by_severity.get("CRITICAL", []),
            "serious_issues": issues_by_severity.get("SERIOUS", []),
            "minor_issues": issues_by_severity.get("MINOR", []),
            "suggestions": issues_by_severity.get("SUGGESTION", []),
            "positive_aspects": self._deduplicate(all_positive),
            "conflicts": [],
            "consensus_notes": "Fallback summary - manual review recommended",
            "recommended_focus": [],
        }
