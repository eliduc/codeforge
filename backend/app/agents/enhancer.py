"""
Enhancement agents for improving finalized code.
- DesignEnhancerAgent: UI/UX and visual design improvements
- FunctionalityEnhancerAgent: Features, edge cases, performance improvements
- SecurityEnhancerAgent: Security vulnerability and best practice improvements
- EnhancementSummarizerAgent: Consolidates suggestions from all enhancers
"""

import json
import logging
import re
from typing import Any

from app.agents.base import AgentResult, BaseAgent
from app.db.models import AgentType
from app.llm import LLMError, LLMRouter
from app.utils.json_utils import fix_json

logger = logging.getLogger(__name__)


# ============================================================================
# Prompts
# ============================================================================

DESIGN_ENHANCER_PROMPT = """You are an expert UI/UX designer and frontend architect. Your task is to analyze the provided application code and suggest specific, actionable improvements to its design and user experience.

## SPECIFICATION
{{ specification }}

## FINAL CODE
```{{ language }}
{{ code }}
```

{% if recommendations %}
## USER RECOMMENDATIONS FOR DESIGN IMPROVEMENTS
{{ recommendations }}
{% endif %}

## YOUR TASK
Analyze the code and provide specific, actionable design improvement suggestions. Focus on:

1. **Visual Design** — Color scheme, typography, spacing, visual hierarchy, consistency
2. **Layout & Structure** — Page structure, component organization, responsive design, grid usage
3. **User Experience** — Navigation flow, user feedback, loading states, error states, accessibility
4. **Modern Patterns** — Modern UI patterns, animations/transitions, micro-interactions
5. **Accessibility** — WCAG compliance, keyboard navigation, screen reader support, contrast ratios
6. **Performance UX** — Perceived performance, skeleton screens, progressive loading

For each suggestion, provide:
- A clear description of what to improve
- Why it matters (impact on user experience)
- Specific implementation guidance (code snippets or detailed instructions)

## OUTPUT FORMAT
Respond with a JSON object:

```json
{
  "suggestions": [
    {
      "id": "DESIGN_1",
      "category": "visual_design|layout|ux|modern_patterns|accessibility|performance_ux",
      "severity": "high|medium|low",
      "title": "Brief title",
      "description": "Detailed description of the improvement",
      "impact": "Why this matters for users",
      "implementation": "Specific guidance on how to implement this"
    }
  ],
  "overall_assessment": "Brief overall assessment of current design quality",
  "priority_improvements": ["DESIGN_1", "DESIGN_3"]
}
```
"""

FUNCTIONALITY_ENHANCER_PROMPT = """You are an expert software architect and developer. Your task is to analyze the provided application code and suggest specific, actionable improvements to its functionality and code quality.

## SPECIFICATION
{{ specification }}

## FINAL CODE
```{{ language }}
{{ code }}
```

{% if recommendations %}
## USER RECOMMENDATIONS FOR FUNCTIONALITY IMPROVEMENTS
{{ recommendations }}
{% endif %}

## YOUR TASK
Analyze the code and provide specific, actionable functionality improvement suggestions. Focus on:

1. **Feature Completeness** — Missing features from specification, edge cases not handled
2. **Error Handling** — Proper error boundaries, graceful degradation, user-facing error messages
3. **Performance** — Algorithm efficiency, unnecessary re-renders, memory leaks, caching opportunities
4. **Code Quality** — Code structure, DRY violations, naming, modularity, separation of concerns
5. **Data Handling** — Input validation, data transformations, state management, data flow
6. **Testing & Reliability** — Testability, logging, monitoring hooks, fault tolerance

For each suggestion, provide:
- A clear description of what to improve
- Why it matters (impact on application quality)
- Specific implementation guidance (code snippets or detailed instructions)

## OUTPUT FORMAT
Respond with a JSON object:

```json
{
  "suggestions": [
    {
      "id": "FUNC_1",
      "category": "completeness|error_handling|performance|code_quality|data_handling|reliability",
      "severity": "high|medium|low",
      "title": "Brief title",
      "description": "Detailed description of the improvement",
      "impact": "Why this matters for application quality",
      "implementation": "Specific guidance on how to implement this"
    }
  ],
  "overall_assessment": "Brief overall assessment of current functionality",
  "priority_improvements": ["FUNC_1", "FUNC_2"]
}
```
"""

SECURITY_ENHANCER_PROMPT = """You are an expert application security engineer. Your task is to analyze the provided application code and suggest specific, actionable security improvements.

## SPECIFICATION
{{ specification }}

## FINAL CODE
```{{ language }}
{{ code }}
```

{% if recommendations %}
## USER RECOMMENDATIONS FOR SECURITY IMPROVEMENTS
{{ recommendations }}
{% endif %}

## YOUR TASK
Analyze the code and provide specific, actionable security improvement suggestions. Focus on:

1. **Input Validation** — User input sanitization, type checking, boundary validation
2. **Injection Prevention** — SQL injection, XSS, command injection, template injection
3. **Authentication & Authorization** — Auth mechanisms, session management, access controls
4. **Data Protection** — Sensitive data handling, encryption, secrets management, PII
5. **Dependency Security** — Known vulnerabilities, outdated packages, supply chain risks
6. **Secure Coding** — Secure defaults, principle of least privilege, error information leakage

For each suggestion, provide:
- A clear description of the vulnerability or improvement
- Risk level and potential impact if exploited
- Specific remediation guidance (code snippets or detailed instructions)

## OUTPUT FORMAT
Respond with a JSON object:

```json
{
  "suggestions": [
    {
      "id": "SEC_1",
      "category": "input_validation|injection|auth|data_protection|dependencies|secure_coding",
      "severity": "critical|high|medium|low",
      "title": "Brief title",
      "description": "Detailed description of the vulnerability or improvement",
      "impact": "Potential impact if not addressed",
      "implementation": "Specific remediation guidance"
    }
  ],
  "overall_assessment": "Brief overall security assessment",
  "priority_improvements": ["SEC_1", "SEC_2"]
}
```
"""

ENHANCEMENT_SUMMARIZER_PROMPT = """You are an expert technical lead. Your task is to analyze improvement suggestions from multiple specialized reviewers (Design, Functionality, Security) and create a consolidated, prioritized improvement plan.

## SPECIFICATION
{{ specification }}

## FINAL CODE
```{{ language }}
{{ code }}
```

## IMPROVEMENT SUGGESTIONS

{% if design_suggestions %}
### Design Improvements
```json
{{ design_suggestions }}
```
{% endif %}

{% if functionality_suggestions %}
### Functionality Improvements
```json
{{ functionality_suggestions }}
```
{% endif %}

{% if security_suggestions %}
### Security Improvements
```json
{{ security_suggestions }}
```
{% endif %}

## YOUR TASK
Critically analyze ALL suggestions from the reviewers and create a consolidated improvement plan:

1. **Evaluate** each suggestion for feasibility, impact, and potential conflicts
2. **Remove** duplicates and merge overlapping suggestions
3. **Prioritize** by impact — security critical issues first, then high-impact UX/functionality
4. **Resolve conflicts** — if suggestions contradict each other, pick the better approach
5. **Create** a single actionable improvement list grouped by topic

Map severity levels from reviewers to priority: critical→critical, high→high, medium→medium, low→low.

Be critical — reject suggestions that are impractical, low-value, or could introduce regressions. Keep only improvements that will meaningfully enhance the application.

## OUTPUT FORMAT
Respond with a JSON object:

```json
{
  "consolidated_improvements": {
    "security": [
      {
        "id": "IMP_SEC_1",
        "title": "Brief title",
        "description": "What to improve",
        "implementation": "How to implement",
        "priority": "critical|high|medium|low",
        "source": "SEC_1"
      }
    ],
    "functionality": [
      {
        "id": "IMP_FUNC_1",
        "title": "Brief title",
        "description": "What to improve",
        "implementation": "How to implement",
        "priority": "critical|high|medium|low",
        "source": "FUNC_1"
      }
    ],
    "design": [
      {
        "id": "IMP_DESIGN_1",
        "title": "Brief title",
        "description": "What to improve",
        "implementation": "How to implement",
        "priority": "critical|high|medium|low",
        "source": "DESIGN_1"
      }
    ]
  },
  "rejected_suggestions": [
    {
      "id": "DESIGN_5",
      "reason": "Why this suggestion was rejected"
    }
  ],
  "summary": "Brief narrative summary of the improvement plan",
  "total_improvements": 0,
  "critical_count": 0,
  "high_count": 0
}
```
"""


# ============================================================================
# Agent Classes
# ============================================================================


class DesignEnhancerAgent(BaseAgent):
    """Agent that suggests design and UX improvements."""

    agent_type = AgentType.ENHANCER_DESIGN

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.5,
        max_tokens: int = 32768,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or DESIGN_ENHANCER_PROMPT,
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
        recommendations: str | None = None,
        **kwargs,
    ) -> AgentResult:
        """Analyze code and suggest design improvements."""
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            language=language,
            recommendations=recommendations,
        )

        system_prompt = (
            "You are an expert UI/UX designer. You analyze code and provide specific, "
            "actionable design improvement suggestions in JSON format."
        )

        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        try:
            parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse design enhancer response: {e}")
            return self._create_result(response, {"raw_content": response.content, "parse_error": str(e)})

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse enhancer response JSON."""
        return _parse_enhancer_json(content, prefix="DESIGN")


class FunctionalityEnhancerAgent(BaseAgent):
    """Agent that suggests functionality and code quality improvements."""

    agent_type = AgentType.ENHANCER_FUNC

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.5,
        max_tokens: int = 32768,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or FUNCTIONALITY_ENHANCER_PROMPT,
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
        recommendations: str | None = None,
        **kwargs,
    ) -> AgentResult:
        """Analyze code and suggest functionality improvements."""
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            language=language,
            recommendations=recommendations,
        )

        system_prompt = (
            "You are an expert software architect. You analyze code and provide specific, "
            "actionable functionality improvement suggestions in JSON format."
        )

        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        try:
            parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse functionality enhancer response: {e}")
            return self._create_result(response, {"raw_content": response.content, "parse_error": str(e)})

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse enhancer response JSON."""
        return _parse_enhancer_json(content, prefix="FUNC")


class SecurityEnhancerAgent(BaseAgent):
    """Agent that suggests security improvements."""

    agent_type = AgentType.ENHANCER_SECURITY

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.3,
        max_tokens: int = 32768,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or SECURITY_ENHANCER_PROMPT,
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
        recommendations: str | None = None,
        **kwargs,
    ) -> AgentResult:
        """Analyze code and suggest security improvements."""
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            language=language,
            recommendations=recommendations,
        )

        system_prompt = (
            "You are an expert application security engineer. You analyze code and provide "
            "specific, actionable security improvement suggestions in JSON format."
        )

        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        try:
            parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse security enhancer response: {e}")
            return self._create_result(response, {"raw_content": response.content, "parse_error": str(e)})

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse enhancer response JSON."""
        return _parse_enhancer_json(content, prefix="SEC")


class EnhancementSummarizerAgent(BaseAgent):
    """Agent that consolidates enhancement suggestions from all enhancers."""

    agent_type = AgentType.ENHANCER_SUMMARY

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.3,
        max_tokens: int = 32768,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or ENHANCEMENT_SUMMARIZER_PROMPT,
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
        design_suggestions: str | None = None,
        functionality_suggestions: str | None = None,
        security_suggestions: str | None = None,
        **kwargs,
    ) -> AgentResult:
        """Consolidate all enhancement suggestions into a prioritized plan."""
        prompt = self.render_prompt(
            specification=specification,
            code=code,
            language=language,
            design_suggestions=design_suggestions,
            functionality_suggestions=functionality_suggestions,
            security_suggestions=security_suggestions,
        )

        system_prompt = (
            "You are an expert technical lead. You consolidate and prioritize improvement "
            "suggestions from multiple reviewers into a single actionable plan in JSON format."
        )

        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        try:
            parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse enhancement summarizer response: {e}")
            return self._create_result(response, {"raw_content": response.content, "parse_error": str(e)})

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse enhancement summarizer JSON response."""
        return _parse_enhancer_json(content, prefix="IMP")


# ============================================================================
# Helper: parse JSON from LLM response
# ============================================================================


def _parse_enhancer_json(content: str, prefix: str = "") -> dict[str, Any]:
    """Extract and parse JSON from LLM response content.

    Handles cases where JSON is wrapped in ```json ... ``` blocks
    or mixed with narrative text.
    """
    # Try to extract JSON from code block
    json_match = re.search(r"```(?:json)?\s*\n(.*?)```", content, re.DOTALL)
    json_str = json_match.group(1).strip() if json_match else content.strip()

    # Try to find JSON object in the string
    if not json_str.startswith("{"):
        brace_start = json_str.find("{")
        if brace_start >= 0:
            # Find matching closing brace, respecting quoted strings
            depth = 0
            in_string = False
            for i in range(brace_start, len(json_str)):
                ch = json_str[i]
                if in_string:
                    if ch == '"' and (i == 0 or json_str[i - 1] != '\\'):
                        in_string = False
                else:
                    if ch == '"':
                        in_string = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            json_str = json_str[brace_start:i + 1]
                            break

    try:
        parsed = json.loads(json_str)
        return parsed
    except json.JSONDecodeError:
        # Try fix_json utility
        fixed = fix_json(json_str)
        if fixed:
            try:
                parsed = json.loads(fixed)
                return parsed
            except json.JSONDecodeError:
                pass

    # Last resort: return raw content
    logger.warning(f"Could not parse enhancer JSON response (prefix={prefix}), returning raw")
    return {
        "suggestions": [],
        "consolidated_improvements": {},
        "overall_assessment": content[:500],
        "raw_content": content[:5000],
        "parse_error": "Could not extract valid JSON from response",
    }


def format_suggestions_for_spec(consolidated: dict[str, Any]) -> str:
    """Format consolidated improvement suggestions as compact text for specification.

    Produces a concise bullet list for appending to the specification.
    """
    improvements = consolidated.get("consolidated_improvements", {})

    if not improvements:
        return ""

    lines = ["## ENHANCEMENTS"]

    for section in ["security", "functionality", "design"]:
        for item in improvements.get(section, []):
            priority = item.get("priority", "medium").upper()
            title = item.get("title", "Untitled")
            desc = item.get("description", "")
            lines.append(f"- [{priority}] {title}: {desc}")

    return "\n".join(lines)
