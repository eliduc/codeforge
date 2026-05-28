"""Finalizer agent implementation - selects best version and generates docs."""

import json
import logging
import os
import re
from typing import Any

from app.agents.base import AgentResult, BaseAgent
from app.db.models import AgentType
from app.llm import LLMError, LLMRouter
from app.utils.json_utils import fix_json as _shared_fix_json

logger = logging.getLogger(__name__)

# Maximum number of characters of code shown in the finalizer prompt per version.
# The full code is preserved by the system; this only limits what is sent to the LLM.
MAX_CODE_DISPLAY_CHARS = 50000


# Default prompt template for finalizer agent
DEFAULT_FINALIZER_PROMPT = """You are an expert software architect tasked with selecting the best code implementation and generating final documentation.

## SPECIFICATION
{{ specification }}

## CODE VERSIONS TO EVALUATE
{% for version in versions %}
### Coder {{ version.coder_index + 1 }} (coder_index={{ version.coder_index }}) - Iteration {{ version.iteration }}

**Scores:**
- Spec Compliance: {{ version.scores.spec_compliance or 'N/A' }}/10
- Correctness: {{ version.scores.correctness or 'N/A' }}/10
- Code Quality: {{ version.scores.quality or 'N/A' }}/10

**Remaining Issues:**
{% if version.remaining_issues.critical %}
- CRITICAL: {{ version.remaining_issues.critical | length }} issues
{% endif %}
{% if version.remaining_issues.serious %}
- SERIOUS: {{ version.remaining_issues.serious | length }} issues
{% endif %}
{% if version.remaining_issues.minor %}
- MINOR: {{ version.remaining_issues.minor | length }} issues
{% endif %}

**Code ({{ version.code|length }} chars total):**
```{{ language }}
{{ version.code[:50000] }}{% if version.code|length > 50000 %}

... [TRUNCATED: showing first 50000 of {{ version.code|length }} chars. Rely on test scores and summary, not raw code. The COMPLETE code is preserved by the system and will be used as-is for the selected coder.]
{% endif %}
```

**Positive Aspects:**
{% for aspect in version.positive_aspects %}
- {{ aspect }}
{% endfor %}

---
{% endfor %}

**IMPORTANT: All code versions shown above are COMPLETE and FULLY FUNCTIONAL in the system. Even if only the first portion is shown above for context window reasons, the system stores and will use the full unmodified code of the selected coder. Do NOT assume any code is truncated or incomplete — judge quality based on what you can see.**

{% if execution_results %}
## EXECUTION RESULTS
{% for result in execution_results %}
### Coder {{ result.coder_index + 1 }} (coder_index={{ result.coder_index }})
- Exit Code: {{ result.exit_code }}
- Execution Time: {{ result.execution_time_ms }}ms
{% if result.stdout %}
**Output:**
```
{{ result.stdout[:1000] }}
```
{% endif %}
{% if result.stderr %}
**Errors:**
```
{{ result.stderr[:500] }}
```
{% endif %}
---
{% endfor %}
{% endif %}

## YOUR TASK
1. **Analyze** each code version against the specification
2. **Check execution results** — versions that fail to run (non-zero exit code, runtime errors) should be penalized heavily
3. **Select** the best implementation — the one that **best matches the specification**:
   - Specification compliance is THE PRIMARY criterion
   - The code MUST execute without errors (if execution results are provided)
   - Code quality and maintainability are secondary
   - A version with fewer features but working correctly is better than one with more features that crashes
4. **Generate** comprehensive documentation:
   - README with usage instructions
   - API documentation (if applicable)
   - Known limitations

## CRITICAL RULES
- "selected_coder_index" MUST be the exact coder_index value shown in parentheses in the headers above (0-based integer). For example, if you choose "Coder 1 (coder_index=0)", set selected_coder_index to 0. If you choose "Coder 2 (coder_index=1)", set selected_coder_index to 1.
- Set "final_code" to an empty string "" — the system will automatically use the full code of the selected coder
- Do NOT try to regenerate, rewrite, or reproduce the code — just select the best version via selected_coder_index
- Put README content in "readme_content", NOT in "final_code"
- Put file descriptions in "file_structure", NOT in "final_code"
- ALL code versions are COMPLETE in the system. If you see a partial view due to length, the full code IS available and will be used. Do NOT penalize any version for appearing "truncated" — that is a display limitation, not a code problem. Judge solely by visible code quality, execution results, and spec compliance.

## SELECTION CRITERIA WEIGHTS
- Specification Compliance: 45%
- Runs Without Errors (execution results): 30%
- Code Quality: 15%
- Remaining Issues Severity: 10%

## OUTPUT FORMAT
Respond with a JSON object (and ONLY JSON, no markdown):

{
    "selected_coder_index": 0,
    "selection_reasoning": "Detailed explanation of why this version was selected",
    "comparison_summary": {
        "coder_0": {
            "strengths": ["..."],
            "weaknesses": ["..."],
            "overall_score": 8.5
        },
        "coder_1": {
            "strengths": ["..."],
            "weaknesses": ["..."],
            "overall_score": 7.8
        }
    },
    "final_code": "",
    "file_structure": {
        "main.py": "Main application file",
        "utils.py": "Utility functions"
    },
    "readme_content": "# Project Name\\n\\n## Overview\\n...",
    "api_docs": "## API Documentation\\n\\n### Endpoints\\n...",
    "known_limitations": [
        "Limitation 1",
        "Limitation 2"
    ],
    "improvement_suggestions": [
        "Suggestion for future improvement"
    ],
    "final_scores": {
        "spec_compliance": 9,
        "correctness": 8,
        "quality": 8,
        "overall": 8.5
    }
}
"""


# Prompt for repo modification finalization
REPO_FINALIZER_PROMPT = """You are an expert software architect tasked with selecting the best set of repository modifications and generating final documentation.

## SPECIFICATION / TASK
{{ specification }}

## MODIFICATION VERSIONS TO EVALUATE
{% for version in versions %}
### Coder {{ version.coder_index + 1 }} (coder_index={{ version.coder_index }}) - Iteration {{ version.iteration }}

**Scores:**
- Spec Compliance: {{ version.scores.spec_compliance or 'N/A' }}/10
- Correctness: {{ version.scores.correctness or 'N/A' }}/10
- Code Quality: {{ version.scores.quality or 'N/A' }}/10

**Remaining Issues:**
{% if version.remaining_issues.critical %}
- CRITICAL: {{ version.remaining_issues.critical | length }} issues
{% endif %}
{% if version.remaining_issues.serious %}
- SERIOUS: {{ version.remaining_issues.serious | length }} issues
{% endif %}
{% if version.remaining_issues.minor %}
- MINOR: {{ version.remaining_issues.minor | length }} issues
{% endif %}

{% if version.repo_files %}
**Modified Files ({{ version.repo_files.modified_files | length }} modified, {{ version.repo_files.new_files | length }} new, {{ version.repo_files.deleted_files | length }} deleted):**
{% for path, content in version.repo_files.modified_files.items() %}
### FILE: {{ path }}
```
{{ content[:20000] }}{% if content|length > 20000 %}
... [truncated — full file is {{ content|length }} chars]
{% endif %}
```
{% endfor %}
{% for path, content in version.repo_files.new_files.items() %}
### NEW FILE: {{ path }}
```
{{ content[:20000] }}{% if content|length > 20000 %}
... [truncated — full file is {{ content|length }} chars]
{% endif %}
```
{% endfor %}
{% if version.repo_files.deleted_files %}
**Deleted Files:**
{% for path in version.repo_files.deleted_files %}
- {{ path }}
{% endfor %}
{% endif %}

**Change Summary:** {{ version.repo_files.change_summary or 'N/A' }}
{% else %}
**Code ({{ version.code|length }} chars total):**
```{{ language }}
{{ version.code[:50000] }}{% if version.code|length > 50000 %}

... [showing first 50000 of {{ version.code|length }} chars — the COMPLETE code is available to the system]
{% endif %}
```
{% endif %}

**Positive Aspects:**
{% for aspect in version.positive_aspects %}
- {{ aspect }}
{% endfor %}

---
{% endfor %}

## YOUR TASK
1. **Analyze** each set of modifications against the specification
2. **Select** the best implementation based on:
   - Specification compliance
   - Correctness of modifications
   - Code quality and consistency with existing codebase
   - Severity of remaining issues
3. **Output** the final set of modified files
4. **Generate** documentation about the changes

## OUTPUT FORMAT
Respond with a JSON object (and ONLY JSON, no markdown):

{
    "selected_coder_index": 0,
    "selection_reasoning": "Detailed explanation of why this version was selected",
    "comparison_summary": {
        "coder_0": {
            "strengths": ["..."],
            "weaknesses": ["..."],
            "overall_score": 8.5
        }
    },
    "modified_files": {
        "path/to/file.py": "complete file content",
        "path/to/other.js": "complete file content"
    },
    "new_files": {
        "path/to/new_file.py": "complete file content"
    },
    "deleted_files": ["path/to/old_file.py"],
    "final_code": "concatenated version of all modified/new files for display",
    "file_structure": {
        "path/to/file.py": {"content": "...", "action": "modified"},
        "path/to/new_file.py": {"content": "...", "action": "created"},
        "path/to/old_file.py": {"action": "deleted"}
    },
    "readme_content": "# Changes\\n\\n## Summary\\n...",
    "known_limitations": ["..."],
    "improvement_suggestions": ["..."],
    "final_scores": {
        "spec_compliance": 9,
        "correctness": 8,
        "quality": 8,
        "overall": 8.5
    }
}
"""


class FinalizerAgent(BaseAgent):
    """Agent that selects the best code version and generates final documentation."""

    agent_type = AgentType.FINALIZER

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.4,  # Balanced between creativity and consistency
        max_tokens: int = 32768,  # Large output for docs + repo mode
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or DEFAULT_FINALIZER_PROMPT,
            agent_index=agent_index,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

    async def execute(
        self,
        specification: str,
        versions: list[dict[str, Any]],
        language: str = "python",
        execution_results: list[dict[str, Any]] | None = None,
        repo_mode: bool = False,
    ) -> AgentResult:
        """
        Select the best code version and generate final documentation.

        Args:
            specification: The code specification
            versions: List of code versions with scores and issues
            language: Programming language
            execution_results: Optional execution results for each version
            repo_mode: If True, use repo modification prompt
        """
        # Use repo prompt or standard prompt
        if repo_mode:
            env = self._get_jinja_env()
            template = env.from_string(REPO_FINALIZER_PROMPT)
            prompt = template.render(
                specification=specification,
                versions=versions,
                language=language,
            )
        else:
            # Render prompt
            prompt = self.render_prompt(
                specification=specification,
                versions=versions,
                language=language,
                execution_results=execution_results,
            )

        # Log code sizes and prompt length; warn loudly on truncation
        for v in versions:
            code_len = len(v.get("code", ""))
            coder_idx = v.get("coder_index", 0)
            logger.info(f"Finalizer: Coder {coder_idx + 1} code = {code_len} chars")
            if code_len > MAX_CODE_DISPLAY_CHARS:
                logger.warning(
                    f"Finalizer: code truncated from {code_len} to {MAX_CODE_DISPLAY_CHARS} chars "
                    f"for coder {coder_idx} — full code is preserved server-side; LLM sees a partial view. "
                    f"Selection should rely on test scores and summary, not raw code."
                )
        logger.info(f"Finalizer: prompt length = {len(prompt)} chars (~{len(prompt) // 4} tokens est.)")

        system_prompt = (
            "You are an expert software architect. "
            "You evaluate code implementations objectively and make data-driven decisions. "
            "You write comprehensive, professional documentation. "
            "CRITICAL: The 'final_code' field must contain ONLY executable source code — "
            "never include README text, config templates, JSON samples, or file markers like '# === filename ==='. "
            "Put documentation in 'readme_content', not in 'final_code'. "
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
            logger.error(f"Failed to parse finalizer response: {e}")
            # Try to create a basic result
            fallback = self._create_fallback_result(versions)
            return AgentResult(
                success=True,
                content=response.content,
                parsed_data=fallback,
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                cost_usd=self.llm_router.calculate_cost(
                    self.provider, self.model, response.input_tokens, response.output_tokens,
                    getattr(response, 'thinking_tokens', 0) or 0,
                ),
                latency_ms=response.latency_ms,
                raw_response=response.raw_response,
            )

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse the finalizer's JSON response."""
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

        # Try to find JSON object in content
        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            try:
                return self._parse_and_validate(json_match.group(0))
            except json.JSONDecodeError:
                pass

        raise ValueError("Could not parse JSON from finalizer response")

    def _parse_and_validate(self, json_str: str) -> dict[str, Any]:
        """Parse JSON and validate/normalize the structure."""
        # Fix common JSON issues
        json_str = _shared_fix_json(json_str)
        data = json.loads(json_str)

        # Validate and normalize
        result = {
            "selected_coder_index": data.get("selected_coder_index", 0),
            "selection_reasoning": data.get("selection_reasoning", ""),
            "comparison_summary": data.get("comparison_summary", {}),
            "final_code": data.get("final_code", ""),
            "file_structure": data.get("file_structure"),
            "readme_content": data.get("readme_content", ""),
            "api_docs": data.get("api_docs", ""),
            "known_limitations": data.get("known_limitations", []),
            "improvement_suggestions": data.get("improvement_suggestions", []),
            "final_scores": self._normalize_scores(data.get("final_scores", {})),
        }

        # Clean final_code: strip non-code content that LLMs sometimes prepend/append
        if result["final_code"]:
            result["final_code"] = self._clean_final_code(result["final_code"])

        # Handle repo mode fields
        if "modified_files" in data or "new_files" in data or "deleted_files" in data:
            result["repo_mode"] = True
            result["modified_files"] = data.get("modified_files", {})
            result["new_files"] = data.get("new_files", {})
            result["deleted_files"] = data.get("deleted_files", [])

            # Build file_structure if not provided
            if not result["file_structure"]:
                result["file_structure"] = {}
                for path, content in result["modified_files"].items():
                    result["file_structure"][path] = {"content": content, "action": "modified"}
                for path, content in result["new_files"].items():
                    result["file_structure"][path] = {"content": content, "action": "created"}
                for path in result["deleted_files"]:
                    result["file_structure"][path] = {"action": "deleted"}

            # Build final_code from main source file only (not all files)
            if not result["final_code"]:
                all_files = {**result["modified_files"], **result["new_files"]}
                if all_files:
                    # Pick the main source file, not README/config/docs
                    main_file = self._pick_main_source_file(all_files)
                    if main_file:
                        result["final_code"] = all_files[main_file]
                    else:
                        # Fallback: concatenate source files only
                        parts = []
                        for path in sorted(all_files.keys()):
                            if self._is_source_file(path):
                                parts.append(f"# === {path} ===\n{all_files[path]}")
                        result["final_code"] = "\n\n".join(parts) if parts else ""

        return result

    @staticmethod
    def _clean_final_code(code: str) -> str:
        """Strip non-code content from final_code.

        Removes README sections, JSON config templates, and file markers
        that LLMs sometimes include in the code output.
        """
        lines = code.split('\n')
        cleaned_lines = []
        skip_section = False

        for i, line in enumerate(lines):
            # Detect file marker for non-code files (README, JSON, etc.)
            # Supports Python (#), JS/TS/C (//), and HTML (<!-- -->) comment styles
            marker_match = re.match(r'^(?:#|//|<!--)\s*===\s*(.+?)\s*===\s*(?:-->)?$', line)
            if marker_match:
                filename = marker_match.group(1).strip()
                if not FinalizerAgent._is_source_file(filename):
                    # Skip this non-code section until next marker or end
                    skip_section = True
                    continue
                else:
                    # Source file marker — skip the marker line itself but keep code
                    skip_section = False
                    continue

            if skip_section:
                continue

            cleaned_lines.append(line)

        return '\n'.join(cleaned_lines).strip()

    @staticmethod
    def _is_source_file(path: str) -> bool:
        """Check if a file path is a source code file (not docs/config).

        Uses a blocklist approach: known non-source extensions and filenames
        return False; everything else (including unknown extensions) returns True.
        """
        path_lower = path.lower()
        basename = os.path.basename(path_lower)
        _, ext = os.path.splitext(path_lower)

        # Non-source config/data/doc extensions (blocklist)
        non_source_ext = {
            '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
            '.md', '.txt', '.rst', '.csv', '.tsv', '.xml', '.svg',
            '.lock', '.log', '.env', '.gitignore', '.dockerignore',
            '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
            '.woff', '.woff2', '.ttf', '.eot',
        }
        if ext in non_source_ext:
            return False

        # Non-source exact filenames (extensionless or special)
        non_source_basenames = {
            'readme', 'readme.md', 'readme.rst', 'readme.txt',
            'license', 'license.md', 'license.txt',
            'changelog', 'changelog.md', 'contributing', 'contributing.md',
            'makefile', 'dockerfile', 'gemfile', 'rakefile',
            '.gitignore', '.dockerignore', '.editorconfig',
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        }
        if basename in non_source_basenames:
            return False

        # Everything else is considered source (blocklist approach)
        return True

    @staticmethod
    def _pick_main_source_file(files: dict[str, str]) -> str | None:
        """Pick the main source file from a dict of path->content.

        Prefers: main.py, app.py, index.js, etc. Falls back to largest source file.
        """
        main_names = [
            'main.py', 'app.py', 'index.py', '__main__.py',
            'main.js', 'index.js', 'app.js', 'main.ts', 'index.ts', 'app.ts',
            'main.go', 'main.rs', 'Main.java', 'main.c', 'main.cpp',
        ]

        # Try exact basename match
        for name in main_names:
            for path in files:
                if os.path.basename(path) == name:
                    return path

        # Fallback: largest source file
        best_path = None
        best_size = 0
        for path, content in files.items():
            if FinalizerAgent._is_source_file(path) and len(content) > best_size:
                best_size = len(content)
                best_path = path

        return best_path

    def _normalize_scores(self, scores: dict) -> dict[str, float]:
        """Normalize scores to valid values."""
        normalized = {}
        for key in ["spec_compliance", "correctness", "quality", "overall"]:
            if key in scores:
                try:
                    val = float(scores[key])
                    normalized[key] = max(0.0, min(10.0, val))
                except (TypeError, ValueError):
                    pass
        return normalized

    def _create_fallback_result(self, versions: list[dict[str, Any]]) -> dict[str, Any]:
        """Create a basic result when LLM parsing fails."""
        if not versions:
            return {
                "selected_coder_index": 0,
                "selection_reasoning": "No versions to compare",
                "final_code": "",
                "readme_content": "# Project\n\n*Documentation generation failed*",
                "known_limitations": ["Documentation could not be generated automatically"],
            }

        # Filter to versions with non-empty code
        non_empty = [v for v in versions if (v.get("code") or "").strip()]
        candidates = non_empty if non_empty else versions

        # Select version with highest average score
        best_idx = 0
        best_score = -1

        for i, version in enumerate(candidates):
            scores = version.get("scores", {}) or {}
            # Handle None values safely
            score_values = []
            for k in ["spec_compliance", "correctness", "quality"]:
                val = scores.get(k)
                if val is not None and isinstance(val, (int, float)):
                    score_values.append(val)
            avg = sum(score_values) / len(score_values) if score_values else 0
            if avg > best_score:
                best_score = avg
                best_idx = i

        best_version = candidates[best_idx]

        return {
            "selected_coder_index": best_version.get("coder_index", best_idx),
            "selection_reasoning": f"Selected based on highest average score: {best_score:.1f}/10",
            "final_code": best_version.get("code", ""),
            "file_structure": best_version.get("file_structure"),
            "readme_content": self._generate_basic_readme(best_version),
            "api_docs": "",
            "known_limitations": [
                issue.get("description", str(issue))
                for issue in best_version.get("remaining_issues", {}).get("critical", [])
            ],
            "improvement_suggestions": [
                issue.get("description", str(issue))
                for issue in best_version.get("remaining_issues", {}).get("suggestions", [])
            ],
            "final_scores": best_version.get("scores", {}),
        }

    def _generate_basic_readme(self, version: dict[str, Any]) -> str:
        """Generate a basic README for fallback."""
        scores = version.get('scores', {}) or {}
        spec = scores.get('spec_compliance')
        corr = scores.get('correctness')
        qual = scores.get('quality')

        return f"""# Project

## Overview
Auto-generated documentation.

## Code Quality Scores
- Specification Compliance: {spec if spec is not None else 'N/A'}/10
- Correctness: {corr if corr is not None else 'N/A'}/10
- Code Quality: {qual if qual is not None else 'N/A'}/10

## Positive Aspects
{chr(10).join('- ' + aspect for aspect in version.get('positive_aspects', ['No aspects recorded']))}

## Known Issues
{chr(10).join('- ' + issue.get('description', str(issue)) for issue in version.get('remaining_issues', {}).get('minor', [])[:5]) or '- None recorded'}

## Usage
Please review the code for usage instructions.

---
*Documentation auto-generated by CodeForge*
"""
