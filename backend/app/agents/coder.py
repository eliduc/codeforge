"""Coder agent implementation."""

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from app.agents.base import AgentResult, BaseAgent
from app.db.models import AgentType
from app.llm import LLMError, LLMRouter

logger = logging.getLogger(__name__)


# Default prompt template for coder agent
DEFAULT_CODER_PROMPT = """You are an expert software developer. Your task is to generate high-quality, production-ready code based on the specification provided.

## SPECIFICATION
{{ specification }}

{% if initial_code %}
## EXISTING CODE (to improve/extend)
```{{ language }}
{{ initial_code }}
```

**CRITICAL: NON-DEGRADATION RULE**
The existing code above is a WORKING, TESTED implementation. When improving it:
1. **PRESERVE** all existing functionality — every feature that works must continue to work
2. **PRESERVE** output quality — do NOT simplify, reduce, or downgrade any aspect of the existing behavior or output
3. **INCREMENTAL changes only** — modify only the parts related to requested enhancements
4. **DO NOT rewrite from scratch** — build upon the existing code structure
5. If an enhancement conflicts with existing quality, implement it WITHOUT degrading what already works
6. The improved code must be a strict superset of the original functionality
{% endif %}

{% if initial_docs %}
## ADDITIONAL DOCUMENTATION
{{ initial_docs }}
{% endif %}

{% if previous_code %}
## YOUR PREVIOUS CODE (iteration {{ iteration - 1 }})
```{{ language }}
{{ previous_code }}
```
{% endif %}

{% if audit_summary %}
## AUDIT SUMMARY FROM PREVIOUS ITERATION
The following issues were found in your code by multiple code reviewers:

### Critical Issues (MUST FIX)
{% for issue in audit_summary.critical_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
  Suggestion: {{ issue.suggestion or 'N/A' }}
{% endfor %}
{% if not audit_summary.critical_issues %}None{% endif %}

### Serious Issues (MUST FIX)
{% for issue in audit_summary.serious_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
  Suggestion: {{ issue.suggestion or 'N/A' }}
{% endfor %}
{% if not audit_summary.serious_issues %}None{% endif %}

### Minor Issues (SHOULD FIX)
{% for issue in audit_summary.minor_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
{% endfor %}
{% if not audit_summary.minor_issues %}None{% endif %}

### Suggestions (OPTIONAL)
{% for issue in audit_summary.suggestions %}
- [{{ issue.id }}] {{ issue.description }}
{% endfor %}
{% if not audit_summary.suggestions %}None{% endif %}

### Consensus Notes
{{ audit_summary.consensus_notes or 'N/A' }}
{% endif %}

{% if execution_error %}
## EXECUTION ERROR FROM PREVIOUS ITERATION
Your previous code failed to execute in the sandbox. You MUST fix this error
in addition to addressing the audit findings above.

Exit code: {{ execution_error.exit_code }}
{% if execution_error.stderr %}
Error output:
```
{{ execution_error.stderr }}
```
{% endif %}
{% if execution_error.stdout %}
Standard output before crash:
```
{{ execution_error.stdout }}
```
{% endif %}
{% if execution_error.timeout_exceeded %}
NOTE: The program exceeded the timeout limit.
{% endif %}
{% endif %}

{% if intervention %}
## USER INTERVENTION
The user has provided additional guidance:
{{ intervention }}
{% endif %}

## YOUR TASK
{% if language in ['javascript_browser', 'typescript_browser', 'html'] %}
**IMPORTANT: Browser Environment**
The code will run in a web browser, NOT in Node.js. You MUST:
- Generate a COMPLETE, SELF-CONTAINED HTML page (starting with `<!DOCTYPE html>`)
- Include ALL JavaScript/CSS inline within the HTML file
- Use browser APIs (DOM, fetch, Canvas, etc.) — do NOT use `require()`, `fs`, `path`, `process`, or any Node.js APIs
- Create a visual UI with proper HTML elements, CSS styling, and interactive JavaScript
- If the specification describes a CLI tool or utility, adapt it as a web application with form inputs, buttons, and visual output
- Use modern CSS (flexbox, grid) for layout and responsive design
- The page must be fully functional when opened in a browser

**CDN Library Versions (IMPORTANT):**
- Three.js: use `<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>` (versions after 0.160 removed the UMD build)
- For any CDN library, use the global/UMD build loaded via `<script>` tag, NOT ES module imports

**Visual first-impression rule (КАО#VR-24 — IMPORTANT for visual specs):**
Your page WILL be screenshot-captured by an automated headless browser at
0.5s, 2s, 5s, 8s, 12s after page load — there is NO human to click anything.
Within the FIRST ~500ms the page MUST already show something visually
representative of what the program does (not a blank canvas, not just an
intro/menu/config screen, not just a "Press Start" splash).

Acceptable ways to satisfy this rule:
1. Initialize with a meaningful default state (random sample data, a glider
   for Game of Life, a textbook fractal seed, a demo song bar, etc.) and
   auto-start any animation / simulation loop on `DOMContentLoaded`.
2. If you also offer a Start/Pause button, the button toggles the *running*
   state — the demo MUST already be running on first paint. Reset/Clear
   wipes the demo, but the page on first load starts WITH the demo, not
   without it.
3. If you have a configuration UI, render a live preview pane that updates
   from default settings immediately, alongside the controls.

Avoid: gating the entire visual on a "Choose a pattern → press Play" flow.
That produces all-identical screenshots and torpedoes the visual review.

**Notification & worker robustness rule (КАО#VR-42 — IMPORTANT):**
The screenshot capture also picks up ANY toasts / notifications / banners you
emit at runtime. A flood of identical error messages stacked on top of the
canvas will dominate the frame and tank the visual review score, even if
the underlying simulation is correct. Therefore:

1. **Dedupe identical notifications.** Keep a small `recentToasts` Map keyed
   by the message text. If the SAME text has been shown in the last 5
   seconds, silently drop the new one. Reset the entry on its own timeout.

2. **Throttle error toasts to at most one per second**, with a small running
   counter (e.g. "Worker error ×7"). One persistent banner beats a tower of
   identical popups every time.

3. **Web Workers must degrade gracefully.** If you use a Worker:
   - Wrap `worker.onerror` and `worker.onmessageerror` in a try/catch.
   - Keep a `workerErrorCount`. After 3 consecutive failures, terminate the
     worker, set a flag, and **fall back to a main-thread implementation of
     the same computation** (Game of Life ticks, image filters, audio FFT
     etc. all have trivial single-threaded variants). The user must still
     see the simulation running.
   - When using blob URLs for inline workers, validate the blob loaded
     successfully (`worker.onerror` fires synchronously on parse errors —
     handle it before the first `postMessage`).
   - Never let a failing Worker spam errors on every animation frame.

4. **`window.onerror` / `window.onunhandledrejection`** — install handlers
   that silently log to console instead of leaking exceptions to the UI.
{% endif %}
{% if language in ['javascript', 'typescript'] %}
**IMPORTANT: Node.js Environment**
The code will run in Node.js, NOT in a browser. You MUST:
- Use Node.js APIs (require, fs, path, process, etc.)
- Do NOT use browser APIs (document, window, DOM, Canvas, etc.)
- Output results to stdout/console
- The code must be executable with `node main.js`
{% endif %}

{% if iteration == 1 %}
Generate complete, working {{ language }} code that implements the specification. Focus on:
1. Correctness - code must work as specified
2. Completeness - implement ALL requirements
3. Quality - clean, readable, maintainable code
4. Error handling - handle edge cases gracefully
5. Documentation - add helpful comments and docstrings
{% else %}
Review the audit findings and improve your code. You MUST:
1. Fix ALL Critical and Serious issues
2. Address Minor issues where reasonable
3. Consider Suggestions that improve code quality
4. Justify any issue you choose NOT to fix

For each issue, decide:
- ACCEPT: You will fix this issue
- PARTIAL: You will partially address this (explain)
- REJECT: You disagree with this finding (provide justification)
{% endif %}

## OUTPUT FORMAT
Respond in the following structure:

### ANALYSIS
Brief analysis of the task/issues (2-3 sentences)

{% if iteration > 1 %}
### ISSUE RESPONSES
For each issue ID, state your decision:
- ISSUE_ID: ACCEPT/PARTIAL/REJECT - [brief reason]
{% endif %}

### CODE
{% if language in ['javascript_browser', 'typescript_browser', 'html'] %}
```html
[Your complete HTML page with inline CSS and JavaScript]
```
{% else %}
```{{ language }}
[Your complete, working code here]
```
{% endif %}

### FILE STRUCTURE (if multiple files)
```json
{
  "main.py": "main application code",
  "utils.py": "utility functions",
  ...
}
```
(Use appropriate filename for the language, e.g., main.py for Python, index.js for JavaScript, main.go for Go)

### NOTES
Any important notes about the implementation, assumptions made, or known limitations.
"""


# Prompt for fixing execution errors
FIX_EXECUTION_ERROR_PROMPT = """You are an expert software developer. Your code failed to execute and needs to be fixed.

## SPECIFICATION
{{ specification }}

## YOUR CODE THAT FAILED
```{{ language }}
{{ code }}
```

## EXECUTION ERROR
Exit code: {{ exit_code }}
{% if stderr %}
Error output:
```
{{ stderr }}
```
{% endif %}
{% if stdout %}
Standard output before crash:
```
{{ stdout }}
```
{% endif %}
{% if timeout_exceeded %}
NOTE: The program exceeded the timeout limit of {{ timeout }} seconds.
{% endif %}

## FIX ATTEMPT {{ attempt }} of {{ max_attempts }}

## YOUR TASK
Fix the code so it executes successfully without errors. Focus on:
1. Understanding the error message
2. Identifying the root cause
3. Implementing a proper fix
4. Ensuring the code still meets the specification

**CRITICAL: DO NOT DEGRADE THE CODE**
- DO NOT change the core logic unless necessary to fix the error
- DO NOT simplify, reduce output quality, or remove working functionality
- DO NOT remove features that work correctly just to avoid the error
- Fix ONLY the specific error — make the MINIMAL change needed
- If the error is a timeout, optimize performance without reducing output quality or removing features

{% if language in ['javascript_browser', 'typescript_browser', 'html'] %}
Note: This code runs in a browser environment (validated in headless Chromium). Do not use Node.js APIs.
The errors above were captured from the browser console. Common browser-specific issues include:
- WebGL/GLSL shader compilation errors (e.g. passing constants to `out`/`inout` parameters — use local variables instead)
- Missing DOM elements at script execution time
- CDN resource loading failures
- Canvas/WebGL context issues
{% elif language in ['javascript', 'typescript'] %}
Note: This code runs in a Node.js environment. Do not use browser APIs.
{% endif %}

## OUTPUT FORMAT
### ANALYSIS
Brief analysis of what caused the error and how to fix it.

### CODE
{% if language in ['javascript_browser', 'typescript_browser', 'html'] %}
```html
[Your fixed, complete HTML page here]
```
{% else %}
```{{ language }}
[Your fixed, complete code here]
```
{% endif %}

### FIX DESCRIPTION
Brief description of what you changed to fix the error.
"""


# Prompt for repo modification mode
REPO_MODIFICATION_PROMPT = """You are an expert software developer. Your task is to MODIFY an existing codebase according to the specification.

## Programming Language: {{ language }}

## SPECIFICATION / TASK
{{ specification }}

{% if previous_files %}
## YOUR PREVIOUS MODIFICATIONS (iteration {{ iteration - 1 }})
{% for path, content in previous_files.items() %}
### FILE: {{ path }}
```
{{ content }}
```
{% endfor %}
{% endif %}

{% if audit_summary %}
## AUDIT SUMMARY FROM PREVIOUS ITERATION
The following issues were found in your modifications by multiple code reviewers:

### Critical Issues (MUST FIX)
{% for issue in audit_summary.critical_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
  Suggestion: {{ issue.suggestion or 'N/A' }}
{% endfor %}
{% if not audit_summary.critical_issues %}None{% endif %}

### Serious Issues (MUST FIX)
{% for issue in audit_summary.serious_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
  Suggestion: {{ issue.suggestion or 'N/A' }}
{% endfor %}
{% if not audit_summary.serious_issues %}None{% endif %}

### Minor Issues (SHOULD FIX)
{% for issue in audit_summary.minor_issues %}
- [{{ issue.id }}] {{ issue.description }}
  Location: {{ issue.location or 'N/A' }}
{% endfor %}
{% if not audit_summary.minor_issues %}None{% endif %}

### Suggestions (OPTIONAL)
{% for issue in audit_summary.suggestions %}
- [{{ issue.id }}] {{ issue.description }}
{% endfor %}
{% if not audit_summary.suggestions %}None{% endif %}

### Consensus Notes
{{ audit_summary.consensus_notes or 'N/A' }}
{% endif %}

{% if execution_error %}
## EXECUTION ERROR FROM PREVIOUS ITERATION
Your previous modifications failed to execute. Fix this error along with
the audit findings above.

Exit code: {{ execution_error.exit_code }}
{% if execution_error.stderr %}
Error output:
```
{{ execution_error.stderr }}
```
{% endif %}
{% if execution_error.stdout %}
Standard output before crash:
```
{{ execution_error.stdout }}
```
{% endif %}
{% endif %}

{% if intervention %}
## USER INTERVENTION
The user has provided additional guidance:
{{ intervention }}
{% endif %}

## IMPORTANT RULES
1. You are MODIFYING an existing project, NOT creating a new one
2. Output ONLY the files you have changed or created — do NOT re-output unchanged files
3. Use the EXACT file paths from the original repository
4. Include the COMPLETE content of each modified file (not just the changed parts)
5. If you need to create a new file, mark it with `### NEW FILE:` instead of `### FILE:`
6. If a file should be deleted, list it in the `### DELETED FILES` section
7. Maintain consistency with the existing codebase style, conventions, and patterns

{% if iteration > 1 %}
Review the audit findings and improve your modifications. You MUST:
1. Fix ALL Critical and Serious issues
2. Address Minor issues where reasonable
3. Consider Suggestions that improve code quality

For each issue, decide:
- ACCEPT: You will fix this issue
- PARTIAL: You will partially address this (explain)
- REJECT: You disagree with this finding (provide justification)
{% endif %}

## OUTPUT FORMAT

### ANALYSIS
Brief analysis of what needs to be changed and your approach (2-3 sentences).

{% if iteration > 1 %}
### ISSUE RESPONSES
For each issue ID, state your decision:
- ISSUE_ID: ACCEPT/PARTIAL/REJECT - [brief reason]
{% endif %}

### MODIFIED FILES
Output each modified file with its full path and complete content:

### FILE: path/to/modified_file.py
```
[Complete content of the modified file]
```

### FILE: path/to/another_modified_file.js
```
[Complete content of the modified file]
```

### NEW FILE: path/to/new_file.py
```
[Content of the new file]
```

### DELETED FILES
- path/to/file_to_delete.py
(Leave empty if no files should be deleted)

### CHANGE SUMMARY
Brief summary of all changes made:
- Modified: list of modified files with what changed
- Created: list of new files
- Deleted: list of deleted files

### NOTES
Any important notes about the modifications, assumptions made, or known limitations.
"""


class CoderAgent(BaseAgent):
    """Agent that generates and improves code."""

    agent_type = AgentType.CODER

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str | None = None,
        agent_index: int = 0,
        temperature: float = 0.7,
        max_tokens: int = 8192,
        **kwargs,
    ):
        super().__init__(
            llm_router=llm_router,
            provider=provider,
            model=model,
            prompt_template=prompt_template or DEFAULT_CODER_PROMPT,
            agent_index=agent_index,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        )

    async def execute(
        self,
        specification: str,
        language: str = "python",
        iteration: int = 1,
        initial_code: str | None = None,
        initial_docs: str | None = None,
        previous_code: str | None = None,
        audit_summary: dict[str, Any] | None = None,
        intervention: str | None = None,
        repo_mode: bool = False,
        previous_files: dict[str, str] | None = None,
        execution_error: dict[str, Any] | None = None,
        temperature_override: float | None = None,
        max_tokens_override: int | None = None,
        enable_streaming: bool = False,
        on_stream_chunk: Callable[[str], Awaitable[None]] | None = None,
    ) -> AgentResult:
        """Generate or improve code based on specification and feedback.

        Args:
            repo_mode: If True, use multi-file repo modification prompt.
            previous_files: For repo_mode iterations > 1, the previous file modifications.
            execution_error: Optional dict with keys exit_code, stdout, stderr,
                timeout_exceeded — passed to the prompt for iteration > 1 when
                the previous run failed sandbox execution.
            temperature_override: If provided, used for this call instead of
                ``self.temperature`` (no agent state mutation).
            max_tokens_override: If provided, used for this call instead of
                ``self.max_tokens``. Subject to repo_mode minimum.
            enable_streaming: When True and ``on_stream_chunk`` is provided,
                use the LLM provider's streaming API and invoke the callback
                for each text delta. Falls back to non-streaming if the
                provider does not support streaming. PoC feature flag —
                gated by ``session.settings.streaming = true`` upstream.
            on_stream_chunk: Async callback ``(chunk: str) -> None`` invoked
                for each streamed text delta. Ignored unless
                ``enable_streaming`` is True.
        """
        # Truncate execution error stdout/stderr for prompt sanity
        safe_exec_error: dict[str, Any] | None = None
        if execution_error:
            stdout = execution_error.get("stdout") or ""
            stderr = execution_error.get("stderr") or ""
            if stdout and len(stdout) > 5000:
                stdout = stdout[:5000] + f"\n[... truncated from {len(execution_error.get('stdout') or '')} chars ...]"
            if stderr and len(stderr) > 5000:
                stderr = stderr[:5000] + f"\n[... truncated from {len(execution_error.get('stderr') or '')} chars ...]"
            safe_exec_error = {
                "exit_code": execution_error.get("exit_code"),
                "stdout": stdout,
                "stderr": stderr,
                "timeout_exceeded": execution_error.get("timeout_exceeded", False),
            }

        if repo_mode:
            env = self._get_jinja_env()
            template = env.from_string(REPO_MODIFICATION_PROMPT)
            prompt = template.render(
                specification=specification,
                language=language,
                iteration=iteration,
                previous_files=previous_files,
                audit_summary=audit_summary,
                intervention=intervention,
                execution_error=safe_exec_error,
            )
        else:
            # Render prompt
            prompt = self.render_prompt(
                specification=specification,
                language=language,
                iteration=iteration,
                initial_code=initial_code,
                initial_docs=initial_docs,
                previous_code=previous_code,
                audit_summary=audit_summary,
                intervention=intervention,
                execution_error=safe_exec_error,
            )

        # Map language to display name for system prompt
        lang_display = {
            'javascript_browser': 'JavaScript (Browser/Canvas)',
            'typescript_browser': 'TypeScript (Browser/Canvas)',
            'javascript': 'JavaScript (Node.js)',
            'typescript': 'TypeScript',
            'python': 'Python',
        }.get(language, language)

        system_prompt = (
            f"You are Coder Agent #{self.agent_index + 1}, an expert {lang_display} developer. "
            f"You write clean, efficient, and well-documented code. "
            f"You carefully analyze requirements and produce production-quality implementations."
        )
        if initial_code:
            system_prompt += (
                " You are enhancing existing working code. Your #1 priority is to NEVER degrade "
                "existing functionality or output quality. Make incremental improvements only."
            )

        # Use higher max_tokens for repo mode since full files are larger
        # Caller-supplied override takes precedence, but repo mode floor still applies.
        # КАО#VR-29 — repo-mode floor raised 65536 → 131072 to match the new
        # default coder budget. Multi-file repos can easily exceed 65k tokens.
        effective_max_tokens = max_tokens_override if max_tokens_override is not None else self.max_tokens
        if repo_mode and effective_max_tokens < 131072:
            effective_max_tokens = 131072

        # Call LLM (pass overrides to avoid mutating shared agent state — safe for
        # adaptive per-iteration temperature/max_tokens tuning by the orchestrator)
        if enable_streaming and on_stream_chunk is not None:
            # PoC streaming path. Falls back automatically to non-streaming
            # generate() inside the provider on any error, so behavior is
            # never worse than the baseline.
            effective_temp = (
                temperature_override if temperature_override is not None else self.temperature
            )
            response = await self.llm_router.generate_stream(
                provider=self.provider,
                model=self.model,
                prompt=prompt,
                on_chunk=on_stream_chunk,
                temperature=effective_temp,
                max_tokens=effective_max_tokens,
                system_prompt=system_prompt,
                thinking_effort=self.thinking_effort,
                request_timeout=self.request_timeout,
            )
        else:
            response = await self._call_llm(
                prompt,
                system_prompt,
                max_tokens=effective_max_tokens,
                temperature=temperature_override,
            )

        if isinstance(response, LLMError):
            return self._create_result(response)

        # Parse response
        try:
            if repo_mode:
                parsed = self.parse_repo_response(response.content)
            else:
                parsed = self.parse_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse coder response: {e}")
            # Still return success but with parse error noted
            return AgentResult(
                success=True,
                content=response.content,
                parsed_data={"parse_error": str(e), "raw_content": response.content},
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                thinking_tokens=response.thinking_tokens,
                cost_usd=self.llm_router.calculate_cost(
                    self.provider, self.model, response.input_tokens, response.output_tokens,
                    response.thinking_tokens,
                ),
                latency_ms=response.latency_ms,
                raw_response=response.raw_response,
                stop_reason=getattr(response, 'stop_reason', None),
            )

    async def fix_execution_error(
        self,
        specification: str,
        code: str,
        language: str,
        exit_code: int,
        stdout: str,
        stderr: str,
        timeout_exceeded: bool = False,
        timeout: int = 60,
        attempt: int = 1,
        max_attempts: int = 3,
    ) -> AgentResult:
        """Fix code that failed to execute."""
        env = self._get_jinja_env()
        template = env.from_string(FIX_EXECUTION_ERROR_PROMPT)
        prompt = template.render(
            specification=specification,
            code=code,
            language=language,
            exit_code=exit_code,
            stdout=(stdout[:5000] + f"\n[... truncated from {len(stdout)} chars ...]" if stdout and len(stdout) > 5000 else (stdout or "")),
            stderr=(stderr[:5000] + f"\n[... truncated from {len(stderr)} chars ...]" if stderr and len(stderr) > 5000 else (stderr or "")),
            timeout_exceeded=timeout_exceeded,
            timeout=timeout,
            attempt=attempt,
            max_attempts=max_attempts,
        )

        lang_display = {
            'javascript_browser': 'JavaScript (Browser/Canvas)',
            'typescript_browser': 'TypeScript (Browser/Canvas)',
            'javascript': 'JavaScript (Node.js)',
            'typescript': 'TypeScript',
            'python': 'Python',
        }.get(language, language)

        system_prompt = (
            f"You are Coder Agent #{self.agent_index + 1}, an expert {lang_display} debugger. "
            f"You excel at understanding error messages and fixing code issues quickly."
        )

        # Call LLM
        response = await self._call_llm(prompt, system_prompt)

        if isinstance(response, LLMError):
            return self._create_result(response)

        # Parse response (similar format to regular response)
        try:
            parsed = self.parse_fix_response(response.content)
            return self._create_result(response, parsed)
        except Exception as e:
            logger.error(f"Failed to parse fix response: {e}")
            return AgentResult(
                success=True,
                content=response.content,
                parsed_data={"parse_error": str(e), "raw_content": response.content},
                input_tokens=response.input_tokens,
                output_tokens=response.output_tokens,
                thinking_tokens=response.thinking_tokens,
                cost_usd=self.llm_router.calculate_cost(
                    self.provider, self.model, response.input_tokens, response.output_tokens,
                    response.thinking_tokens,
                ),
                latency_ms=response.latency_ms,
                raw_response=response.raw_response,
                stop_reason=getattr(response, 'stop_reason', None),
            )

    def parse_fix_response(self, content: str) -> dict[str, Any]:
        """Parse the fix response to extract code and analysis."""
        result: dict[str, Any] = {
            "analysis": "",
            "code": "",
            "fix_description": "",
        }

        # Extract analysis
        analysis_match = re.search(
            r"###\s*ANALYSIS\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if analysis_match:
            result["analysis"] = analysis_match.group(1).strip()

        # Extract code
        code_match = re.search(
            r"###\s*CODE\s*\n.*?```\w*\n(.*?)```", content, re.DOTALL | re.IGNORECASE
        )
        if code_match:
            result["code"] = code_match.group(1).strip()
        else:
            # Fallback: find largest code block
            code_blocks = re.findall(r"```\w*\n(.*?)```", content, re.DOTALL)
            if code_blocks:
                result["code"] = max(code_blocks, key=len).strip()

        # Last-resort: truncated response with opening ``` but no closing
        if not result["code"]:
            truncated_match = re.search(
                r"###\s*CODE\s*\n\s*```\w*\n(.*)",
                content, re.DOTALL | re.IGNORECASE
            )
            if truncated_match:
                candidate = truncated_match.group(1).strip()
                candidate = re.sub(r"```\s*$", "", candidate).strip()
                if len(candidate) > 50:
                    result["code"] = candidate
                    logger.warning(
                        f"Fix response: used truncated code fallback ({len(candidate)} chars)"
                    )

        # Extract fix description
        fix_match = re.search(
            r"###\s*FIX\s*DESCRIPTION\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if fix_match:
            result["fix_description"] = fix_match.group(1).strip()

        return result

    def parse_repo_response(self, content: str) -> dict[str, Any]:
        """Parse multi-file repo modification response.

        Returns dict with:
            analysis: str
            issue_responses: dict
            modified_files: dict[path, content]  - files that were changed
            new_files: dict[path, content]  - newly created files
            deleted_files: list[str]  - files to delete
            change_summary: str
            notes: str
            repo_mode: True  - flag to indicate this is a repo modification result
        """
        result: dict[str, Any] = {
            "analysis": "",
            "issue_responses": {},
            "modified_files": {},
            "new_files": {},
            "deleted_files": [],
            "change_summary": "",
            "notes": "",
            "repo_mode": True,
        }

        # Extract analysis
        analysis_match = re.search(
            r"###\s*ANALYSIS\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if analysis_match:
            result["analysis"] = analysis_match.group(1).strip()

        # Extract issue responses (same as standard mode)
        issues_match = re.search(
            r"###\s*ISSUE\s*RESPONSES?\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if issues_match:
            issues_text = issues_match.group(1).strip()
            for line in issues_text.split("\n"):
                line = line.strip()
                if line.startswith("-"):
                    line = line[1:].strip()
                match = re.match(r"(\w+[-_]\d+):\s*(ACCEPT|PARTIAL|REJECT)\s*[-–]\s*(.*)", line, re.IGNORECASE)
                if match:
                    issue_id = match.group(1).upper()
                    decision = match.group(2).upper()
                    reason = match.group(3).strip()
                    result["issue_responses"][issue_id] = {
                        "decision": decision,
                        "reason": reason,
                    }

        # Extract modified files: ### FILE: path
        # Pattern handles both closed (```) and unclosed code blocks (truncated responses)
        file_pattern = re.compile(
            r"###\s*FILE:\s*(.+?)\s*\n\s*```\w*\n(.*?)(?:```|(?=###\s*(?:FILE|NEW\s+FILE|DELETED|CHANGE|NOTES))|$)",
            re.DOTALL | re.IGNORECASE,
        )
        for match in file_pattern.finditer(content):
            filepath = match.group(1).strip()
            file_content = match.group(2).strip()
            if file_content:
                result["modified_files"][filepath] = file_content

        # Extract new files: ### NEW FILE: path
        new_file_pattern = re.compile(
            r"###\s*NEW\s+FILE:\s*(.+?)\s*\n\s*```\w*\n(.*?)(?:```|(?=###\s*(?:FILE|NEW\s+FILE|DELETED|CHANGE|NOTES))|$)",
            re.DOTALL | re.IGNORECASE,
        )
        for match in new_file_pattern.finditer(content):
            filepath = match.group(1).strip()
            file_content = match.group(2).strip()
            result["new_files"][filepath] = file_content

        # Extract deleted files
        deleted_match = re.search(
            r"###\s*DELETED\s*FILES?\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if deleted_match:
            deleted_text = deleted_match.group(1).strip()
            for line in deleted_text.split("\n"):
                line = line.strip().lstrip("-").strip()
                if line and line.lower() not in ("none", "n/a", "(none)", "leave empty if no files should be deleted"):
                    result["deleted_files"].append(line)

        # Extract change summary
        summary_match = re.search(
            r"###\s*CHANGE\s*SUMMARY\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if summary_match:
            result["change_summary"] = summary_match.group(1).strip()

        # Extract notes
        notes_match = re.search(
            r"###\s*NOTES\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if notes_match:
            result["notes"] = notes_match.group(1).strip()

        # Build combined code for backward compat (concatenate all files)
        all_files = {**result["modified_files"], **result["new_files"]}
        if all_files:
            code_parts = []
            for path in sorted(all_files.keys()):
                code_parts.append(f"# === {path} ===\n{all_files[path]}")
            result["code"] = "\n\n".join(code_parts)
        else:
            result["code"] = ""

        total_files = len(result["modified_files"]) + len(result["new_files"])
        logger.info(
            f"Parsed repo response: {len(result['modified_files'])} modified, "
            f"{len(result['new_files'])} new, {len(result['deleted_files'])} deleted, "
            f"content_len={len(content)}"
        )
        if total_files == 0:
            # Debug: check if file markers exist at all
            file_markers = re.findall(r"###\s*(?:NEW\s+)?FILE:\s*(.+)", content, re.IGNORECASE)
            logger.warning(f"No files parsed! File markers found: {file_markers[:10]}")
            # Show first 200 chars around each marker for debugging
            for marker in file_markers[:3]:
                idx = content.find(marker)
                if idx >= 0:
                    snippet = content[max(0, idx-50):idx+200].replace('\n', '\\n')
                    logger.warning(f"  Context around '{marker}': ...{snippet}...")

        return result

    @staticmethod
    def _detect_truncation(code: str, language: str | None = None) -> dict[str, Any]:
        """Detect if generated code looks truncated (LLM hit max_tokens mid-output).

        КАО#VR-29 — when Anthropic/OpenAI hit the response cap they cut off
        mid-statement without warning. For HTML/JS sessions the silent break
        is catastrophic: an unclosed ``<script>`` makes the browser ignore
        ALL inline JS, so every handler in the page is dead. We catch the
        worst classes of truncation cheaply:

          * unbalanced ``<script>`` vs ``</script>``
          * unbalanced ``<style>`` vs ``</style>``
          * unbalanced ``{`` vs ``}`` in the trailing 4 kB (heuristic — full-
            file balance is too noisy because of inline JSON in HTML)
          * trailing line that ends mid-identifier or mid-keyword (no
            terminator ``;`` ``,`` ``)`` ``}`` ``>`` and not a comment / blank)
          * for HTML: missing ``</html>`` and ``</body>`` at EOF

        Returns dict ``{truncated: bool, reasons: [str], severity: str}``.
        ``severity`` = ``critical`` if HTML/JS parsability breaks
        (unbalanced script/style/braces), else ``warning``.
        """
        if not code:
            return {"truncated": False, "reasons": [], "severity": "none"}

        reasons: list[str] = []
        lower = (language or "").lower()
        is_html = lower in (
            "html", "javascript_browser", "typescript_browser", "canvas", "p5js",
        ) or "<!doctype" in code[:200].lower() or "<html" in code[:1000].lower()

        # 1. <script>/<style> tag balance
        open_script = code.count("<script")
        close_script = code.count("</script>")
        if open_script > close_script:
            reasons.append(
                f"unbalanced <script>: {open_script} open, {close_script} close "
                f"(LLM likely truncated mid-script)"
            )
        open_style = code.count("<style")
        close_style = code.count("</style>")
        if open_style > close_style:
            reasons.append(
                f"unbalanced <style>: {open_style} open, {close_style} close"
            )

        # 2. Brace balance in trailing window (catches JS-truncation patterns
        #    even when <script> tags aren't used, e.g. raw Python/JS files)
        tail = code[-4096:] if len(code) > 4096 else code
        # Only consider braces outside strings (very rough — strip string
        # literals first to reduce noise).
        tail_stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '', tail)
        tail_stripped = re.sub(r"'(?:[^'\\]|\\.)*'", "", tail_stripped)
        tail_stripped = re.sub(r"`(?:[^`\\]|\\.)*`", "", tail_stripped)
        open_brace = tail_stripped.count("{")
        close_brace = tail_stripped.count("}")
        if open_brace > close_brace + 2:  # allow some slop
            reasons.append(
                f"unbalanced braces in tail: {open_brace} open vs {close_brace} close"
            )

        # 3. Mid-identifier / mid-keyword tail. A healthy code file ends on
        #    a terminator. A truncated LLM response often ends mid-word.
        # Strip trailing whitespace.
        stripped = code.rstrip()
        if stripped:
            last_char = stripped[-1]
            # Healthy terminators include: ; , ) } ] > " ' ` / (for /* */) and
            # word-end punctuation. Anything else is suspicious.
            if last_char not in (
                ";", ",", ")", "}", "]", ">", '"', "'", "`", "/", "*", "\n",
            ):
                # Look at last line: if it's a comment or pure word, allow.
                last_line = stripped.splitlines()[-1].strip()
                # Common comment markers
                if not last_line.startswith(("//", "#", "/*", "*", "*/")):
                    reasons.append(
                        f"file ends mid-token: {last_line[-40:]!r}"
                    )

        # 4. HTML missing closing tags
        if is_html:
            tail_html = code[-2048:].lower()
            if "</html>" not in tail_html:
                reasons.append("HTML file missing </html> at EOF")
            if "</body>" not in tail_html:
                reasons.append("HTML file missing </body> at EOF")

        # Severity: anything that makes <script> or HTML unparseable is critical.
        critical_markers = ("<script>", "<style>", "</html>", "</body>", "unbalanced braces")
        critical = any(any(m in r for m in critical_markers) for r in reasons)
        severity = "critical" if critical else ("warning" if reasons else "none")
        return {
            "truncated": bool(reasons),
            "reasons": reasons,
            "severity": severity,
            "code_length": len(code),
        }

    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse the coder's response to extract code and metadata."""
        result: dict[str, Any] = {
            "analysis": "",
            "issue_responses": {},
            "code": "",
            "file_structure": None,
            "notes": "",
        }

        # Extract analysis
        analysis_match = re.search(
            r"###\s*ANALYSIS\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if analysis_match:
            result["analysis"] = analysis_match.group(1).strip()

        # Extract issue responses
        issues_match = re.search(
            r"###\s*ISSUE\s*RESPONSES?\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if issues_match:
            issues_text = issues_match.group(1).strip()
            # Parse individual issue responses
            for line in issues_text.split("\n"):
                line = line.strip()
                if line.startswith("-"):
                    line = line[1:].strip()
                # Match pattern like "ISSUE_1: ACCEPT - reason"
                match = re.match(r"(\w+[-_]\d+):\s*(ACCEPT|PARTIAL|REJECT)\s*[-–]\s*(.*)", line, re.IGNORECASE)
                if match:
                    issue_id = match.group(1).upper()
                    decision = match.group(2).upper()
                    reason = match.group(3).strip()
                    result["issue_responses"][issue_id] = {
                        "decision": decision,
                        "reason": reason,
                    }

        # Extract code - find the main code block
        code_section_match = re.search(
            r"###\s*CODE\s*\n(.*?)(?=###\s*FILE\s*STRUCTURE|###\s*NOTES|\Z)",
            content,
            re.DOTALL | re.IGNORECASE,
        )
        if code_section_match:
            code_section = code_section_match.group(1)
            # Extract code from markdown code block
            code_match = re.search(r"```\w*\n(.*?)```", code_section, re.DOTALL)
            if code_match:
                result["code"] = code_match.group(1).strip()

        # Fallback: try to find any substantial code block
        if not result["code"]:
            code_blocks = re.findall(r"```\w*\n(.*?)```", content, re.DOTALL)
            if code_blocks:
                # Find the largest code block (likely the main code)
                result["code"] = max(code_blocks, key=len).strip()

        # Last-resort fallback: response truncated mid-code-block (no closing ```)
        # Extract everything after ### CODE / opening ``` to end of content
        if not result["code"]:
            # Try: ### CODE section with opening ``` but no closing ```
            truncated_match = re.search(
                r"###\s*CODE\s*\n\s*```\w*\n(.*)",
                content, re.DOTALL | re.IGNORECASE
            )
            if truncated_match:
                candidate = truncated_match.group(1).strip()
                # Remove trailing incomplete ``` if any
                candidate = re.sub(r"```\s*$", "", candidate).strip()
                if len(candidate) > 50:  # Must be substantial
                    result["code"] = candidate
                    logger.warning(
                        f"Used truncated code fallback ({len(candidate)} chars) - "
                        f"response likely hit max_tokens"
                    )

        # Extract file structure
        fs_match = re.search(
            r"###\s*FILE\s*STRUCTURE.*?\n```json\s*\n(.*?)```",
            content,
            re.DOTALL | re.IGNORECASE,
        )
        if fs_match:
            try:
                result["file_structure"] = json.loads(fs_match.group(1).strip())
            except json.JSONDecodeError:
                pass

        # Extract notes
        notes_match = re.search(
            r"###\s*NOTES\s*\n(.*?)(?=###|\Z)", content, re.DOTALL | re.IGNORECASE
        )
        if notes_match:
            result["notes"] = notes_match.group(1).strip()

        # КАО#VR-29 — surface truncation status. Stored on the result dict;
        # the orchestrator decides whether to retry / warn the user. A
        # `truncated=True` with severity=critical means the rendered output
        # will be broken (unclosed <script>, missing </html>, etc.). The
        # orchestrator can log this prominently and the UI can surface it
        # in the Visual Review panel.
        result["truncation"] = self._detect_truncation(result.get("code", ""), None)
        if result["truncation"]["truncated"]:
            logger.warning(
                "Coder output truncation detected (severity=%s): %s",
                result["truncation"]["severity"],
                "; ".join(result["truncation"]["reasons"][:3]),
            )

        return result
