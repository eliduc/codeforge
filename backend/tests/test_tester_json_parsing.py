"""Tests for Tester agent JSON parsing robustness.

Covers three scenarios that previously caused warnings/empty audits:

1. LLM wraps JSON in markdown fences with a chatty preface →
   ``fix_json`` / regex extraction recovers the embedded object on the
   first pass.
2. LLM returns plain English on the first call but valid JSON on the
   retry → retry-once logic catches it (INFO log, success).
3. Both attempts fail → fallback result is returned with
   ``audit_passed=False`` and a "LLM failed to produce parseable JSON"
   comment, and the workflow continues.

The LLM router is mocked so no real API is hit.
"""
from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass
from typing import Any

# The google-genai SDK is an optional runtime dep that may not be installed
# in CI/local environments running just this unit-test file. Stub it before
# importing the app modules so the import chain (router -> providers) works
# without the real SDK present. Tests below never touch Google code paths.
if "google.genai" not in sys.modules:
    google_mod = sys.modules.setdefault("google", types.ModuleType("google"))
    genai_mod = types.ModuleType("google.genai")
    genai_mod.Client = object  # type: ignore[attr-defined]
    types_mod = types.ModuleType("google.genai.types")

    class _StubGenAIType:  # noqa: D401 - simple stub
        def __init__(self, *a: Any, **kw: Any) -> None: ...

    types_mod.ThinkingConfig = _StubGenAIType  # type: ignore[attr-defined]
    types_mod.GenerateContentConfig = _StubGenAIType  # type: ignore[attr-defined]
    sys.modules["google.genai"] = genai_mod
    sys.modules["google.genai.types"] = types_mod
    google_mod.genai = genai_mod  # type: ignore[attr-defined]

from app.agents.tester import TesterAgent  # noqa: E402


@dataclass
class _StubResponse:
    """Minimal LLMResponse-compatible stub used by the tests."""

    content: str
    input_tokens: int = 10
    output_tokens: int = 20
    thinking_tokens: int = 0
    latency_ms: int = 5
    raw_response: dict | None = None
    stop_reason: str | None = "end_turn"
    model: str = "stub-model"
    provider: str = "stub"


class _FakeRouter:
    """Router stub that yields a queued sequence of responses."""

    def __init__(self, responses: list[Any]):
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("FakeRouter ran out of queued responses")
        return self._responses.pop(0)

    def calculate_cost(self, *args: Any, **kwargs: Any) -> float:
        return 0.0


def _make_agent(responses: list[Any]) -> tuple[TesterAgent, _FakeRouter]:
    router = _FakeRouter(responses)
    agent = TesterAgent(
        llm_router=router,
        provider="stub",
        model="stub-model",
        agent_index=0,
    )
    return agent, router


_VALID_AUDIT_JSON = (
    '{"overall_assessment": "Looks OK.",'
    ' "spec_compliance_score": 9,'
    ' "correctness_score": 9,'
    ' "quality_score": 8,'
    ' "issues": [{"id": "MIN_1", "severity": "minor",'
    '   "description": "Use a constant for the magic number 42.",'
    '   "category": "style", "location": "main", "evidence": "x = 42",'
    '   "suggestion": "Extract as ANSWER = 42"}],'
    ' "positive_aspects": ["Readable code"],'
    ' "test_cases_needed": []}'
)


def _run(coro):
    """asyncio.run() that works under pytest-asyncio's loop policy too."""
    try:
        return asyncio.run(coro)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


def test_markdown_fenced_json_parses_on_first_attempt():
    """LLM wraps JSON in ```json``` fences with preface — must succeed without retry."""
    raw = "Sure! Here's the JSON:\n```json\n" + _VALID_AUDIT_JSON + "\n```"
    agent, router = _make_agent([_StubResponse(content=raw)])

    result = _run(
        agent.execute(
            specification="Print hello world.",
            code="print('hello world')",
            language="python",
        )
    )

    assert result.success is True, result.error
    assert result.parsed_data is not None
    assert result.parsed_data["overall_assessment"] == "Looks OK."
    assert result.parsed_data["spec_compliance_score"] == 9
    assert len(result.parsed_data["issues"]) == 1
    assert result.parsed_data["issues"][0]["id"] == "MIN_1"
    # Only one LLM call — no retry needed.
    assert len(router.calls) == 1


def test_plain_english_then_valid_json_succeeds_after_retry():
    """First response is prose, second is valid JSON — retry-once recovers."""
    responses = [
        _StubResponse(
            content="I cannot output JSON, here is a prose review instead. "
                    "The code looks fine to me."
        ),
        _StubResponse(content=_VALID_AUDIT_JSON),
    ]
    agent, router = _make_agent(responses)

    result = _run(
        agent.execute(
            specification="Print hello world.",
            code="print('hello world')",
            language="python",
        )
    )

    assert result.success is True, result.error
    assert result.parsed_data is not None
    assert result.parsed_data["overall_assessment"] == "Looks OK."
    # Retry happened — second call must have been issued.
    assert len(router.calls) == 2
    # The retry prompt must carry the stricter directive.
    retry_call = router.calls[1]
    assert "Output ONLY the JSON object now" in retry_call["prompt"]
    # JSON mode must be requested on both calls.
    assert router.calls[0].get("request_json_mode") is True
    assert router.calls[1].get("request_json_mode") is True


def test_both_attempts_fail_returns_fallback_result():
    """Both responses unparseable → fallback audit_passed=False is returned."""
    responses = [
        _StubResponse(content="Sorry, I cannot help with that."),
        _StubResponse(content="Still cannot output JSON for you."),
    ]
    agent, router = _make_agent(responses)

    result = _run(
        agent.execute(
            specification="Print hello world.",
            code="print('hello world')",
            language="python",
        )
    )

    # Workflow continues: success=True (the LLM call worked), but parsed_data
    # carries the empty/fallback audit with the diagnostic fields set.
    assert result.success is True
    assert result.parsed_data is not None
    assert result.parsed_data["audit_passed"] is False
    assert result.parsed_data["comments"] == "LLM failed to produce parseable JSON"
    assert result.parsed_data["issues"] == []
    # Both attempts were made.
    assert len(router.calls) == 2


def test_request_json_mode_is_propagated_on_first_call():
    """Sanity check: first LLM call already uses request_json_mode=True."""
    agent, router = _make_agent([_StubResponse(content=_VALID_AUDIT_JSON)])

    _run(
        agent.execute(
            specification="Print hello world.",
            code="print('hello world')",
            language="python",
        )
    )

    assert router.calls[0]["request_json_mode"] is True
