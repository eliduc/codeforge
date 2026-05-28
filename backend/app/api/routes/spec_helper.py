"""Spec quality scorer + cost estimator (Features 2a/2b).

Both endpoints are LLM-free heuristics — cheap, fast, run before a session
starts so the user can iterate on their spec without burning API credits.

Routes (mounted at /api/spec-helper in main.py):
- POST /spec-score      — quality score + issues + complexity bucket
- POST /cost-estimate   — token / cost / time forecast for a given config
"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SpecScoreRequest(BaseModel):
    specification: str = Field(min_length=1, max_length=200_000)
    language: str | None = None


class SpecScoreResponse(BaseModel):
    overall_score: int  # 0-100
    issues: list[dict]  # [{severity, description, suggestion}]
    estimated_complexity: str  # "trivial" | "moderate" | "complex"
    detected_keywords: list[str]
    word_count: int


class AgentConfigLite(BaseModel):
    """Subset of agent config we need for cost estimation."""

    agent_type: str
    llm_provider: str | None = None
    llm_model: str | None = None


class CostEstimateRequest(BaseModel):
    specification: str = Field(min_length=1, max_length=200_000)
    agent_configs: list[dict] = Field(default_factory=list)
    max_iterations: int = Field(default=5, ge=1, le=50)


class CostEstimateResponse(BaseModel):
    estimated_tokens_per_iter: int
    estimated_total_tokens: int
    estimated_cost_usd: float
    estimated_time_seconds: int
    breakdown: dict[str, float]  # {provider: cost_usd}


# ---------------------------------------------------------------------------
# Spec scoring (Feature 2a)
# ---------------------------------------------------------------------------

# Hand-rolled signals — no LLM round-trip.
#
# КАО — bilingual EN+RU. Russian heuristics use SUBSTRING match because Russian
# morphology (gender/number/case) sprouts many forms from each root: "должн"
# catches должен/должна/должно/должны; "ввод" catches ввод/ввода/вводе/ввести.
# English entries keep word-form because English doesn't inflect like that.
_AMBIGUITY_WORDS = (
    # English
    "maybe", "could", "etc", "etc.", "possibly", "somehow", "tbd",
    # Russian (substring-friendly stems)
    "возможно", "может быть", "наверное", "как-то", "и т.д", "и т. д",
    "что-то", "примерно", "около того",
)
_REQUIREMENT_WORDS = (
    # English
    "should", "must", "shall", "will", "needs to", "required",
    # Russian stems (catch all inflections via substring match)
    "должн",       # должен/должна/должно/должны
    "обязан",      # обязан/обязана/обязано/обязаны
    "необходим",   # необходимо/необходима/необходимы
    "следует",     # "следует делать"
    "нужно", "нужен", "нужна", "нужны",
    "требует", "требуется", "требуются",
    "надо",
)
_IO_HINTS = (
    # English
    "input", "output", "return", "accept", "produce", "argument", "parameter", "result",
    # Russian stems
    "ввод",        # ввод/ввода/ввести
    "вход",        # вход/входные/входной
    "вывод",       # вывод/вывода/вывести
    "выход",       # выход/выходные/выходной
    "возвращ",     # возвращает/возвращать
    "результат",
    "аргумент",
    "параметр",
    "принима",     # принимает/принимать
    "получа",      # получает/получать
    "выда",        # выдаёт/выдавать/выдать
    "отдаёт", "отдает",
)

# Russian verb suffix patterns used by the verb+noun heuristic. Combined with
# the existing English suffixes (-e/-s/-ing/-ed).
_RU_VERB_SUFFIXES = (
    "ть",   # infinitive: обладать, делать
    "ться", # reflexive infinitive: меняться, увеличиваться
    "ет", "ёт", "ит", "ат", "ят",  # 3rd person sg/pl present
    "ают", "яют", "ует", "уют",     # ...ать/...овать present
    "тся", "ются", "ятся",          # reflexive present
    "ал", "ала", "ало", "али",      # past
    "ил", "ила", "ило", "или",
    "найди", "сделай", "построй", "создай",  # imperative stems common in specs
)


def _looks_like_verb(word: str) -> bool:
    """Returns True if ``word`` ends in an English OR Russian verb suffix.

    Cheap heuristic — false positives are fine (e.g. plural nouns matching ``-s``).
    The verb-noun rule below also requires a 3+ word sentence, so noise alone
    won't flip the check.
    """
    w = word.lower()
    if w.endswith(("e", "s", "ing", "ed")):
        return True
    return w.endswith(_RU_VERB_SUFFIXES)

# Match CamelCase / snake_case / function-call-ish identifiers.
_KEYWORD_RE = re.compile(r"\b([A-Z][a-zA-Z0-9]{2,}|[a-z_][a-z0-9_]{2,}\(\)|[a-z]+_[a-z_]+)\b")
_LIBRARY_RE = re.compile(
    r"\b(numpy|pandas|fastapi|flask|django|react|vue|pytorch|tensorflow|sklearn|"
    r"requests|httpx|sqlalchemy|pytest|jest|express|next\.?js|axios|redis|postgres|mysql)\b",
    re.IGNORECASE,
)


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"[.!?]+", text) if s.strip()]


def _score_specification(spec: str) -> SpecScoreResponse:
    words = spec.split()
    word_count = len(words)
    sentences = _split_sentences(spec)
    lower = spec.lower()

    score = 100
    issues: list[dict] = []

    # 1. Length deduction
    if word_count < 50:
        score -= 30
        issues.append({
            "severity": "serious",
            "description": f"Specification is very short ({word_count} words).",
            "suggestion": "Add more detail: inputs, outputs, edge cases, expected behavior.",
        })

    # 2. Verb-noun structure: at least one sentence with a verb-ish word
    #    (English -e/-s/-ing/-ed OR Russian -ть/-ться/-ет/-ает/-ают/etc.)
    #    AND length >= 3 words. _looks_like_verb handles both languages.
    has_verb_noun = any(
        any(_looks_like_verb(w) for w in s.split()) and len(s.split()) >= 3
        for s in sentences
    )
    if not has_verb_noun:
        score -= 20
        issues.append({
            "severity": "minor",
            "description": "Spec lacks clear action sentences (verb + object).",
            "suggestion": "Use sentences like 'The function should return X when given Y'.",
        })

    # 3. Requirement keywords ("should"/"must")
    if not any(w in lower for w in _REQUIREMENT_WORDS):
        score -= 10
        issues.append({
            "severity": "minor",
            "description": "No requirement keywords ('should', 'must', etc.) detected.",
            "suggestion": "State requirements explicitly with 'must' or 'should'.",
        })

    # 4. Run-on sentence detection
    if sentences and max(len(s.split()) for s in sentences) > 80:
        score -= 15
        issues.append({
            "severity": "minor",
            "description": "Found a very long single sentence (>80 words).",
            "suggestion": "Break long sentences into bullet points or shorter clauses.",
        })

    # 5. Ambiguity words
    found_ambiguous = sorted({w for w in _AMBIGUITY_WORDS if w in lower})
    if found_ambiguous:
        issues.append({
            "severity": "minor",
            "description": f"Ambiguous wording detected: {', '.join(found_ambiguous)}.",
            "suggestion": "Replace vague words with concrete requirements.",
        })

    # 6. Missing I/O mention
    if not any(h in lower for h in _IO_HINTS):
        issues.append({
            "severity": "serious",
            "description": "No mention of input or output behavior.",
            "suggestion": "Describe what the code receives and what it produces.",
        })

    score = max(0, min(100, score))

    # Complexity bucket
    if word_count < 100:
        complexity = "trivial"
    elif word_count <= 500:
        complexity = "moderate"
    else:
        complexity = "complex"

    # Keyword extraction (dedup, capped)
    keywords: list[str] = []
    seen: set[str] = set()
    for m in _KEYWORD_RE.findall(spec):
        k = m.strip("()")
        kl = k.lower()
        if kl not in seen and len(k) > 2:
            seen.add(kl)
            keywords.append(k)
    for m in _LIBRARY_RE.findall(spec):
        kl = m.lower()
        if kl not in seen:
            seen.add(kl)
            keywords.append(m)
    keywords = keywords[:30]

    return SpecScoreResponse(
        overall_score=score,
        issues=issues,
        estimated_complexity=complexity,
        detected_keywords=keywords,
        word_count=word_count,
    )


@router.post("/spec-score", response_model=SpecScoreResponse)
async def spec_score(payload: SpecScoreRequest) -> SpecScoreResponse:
    """Heuristic quality score for a draft specification.

    LLM-free; safe to call on every keystroke (debounced) from the UI.
    """
    return _score_specification(payload.specification)


# ---------------------------------------------------------------------------
# Cost estimation (Feature 2b)
# ---------------------------------------------------------------------------

# (input_per_1m_usd, output_per_1m_usd) — best-effort rates.
# Falls back to OPENAI_GENERIC_RATE for unknown models.
_RATES: dict[tuple[str, str], tuple[float, float]] = {
    ("openai", "gpt-5"): (5.0, 15.0),
    ("openai", "gpt-5-mini"): (0.50, 2.0),
    ("openai", "gpt-4o"): (2.5, 10.0),
    ("openai", "gpt-4o-mini"): (0.15, 0.60),
    ("anthropic", "claude-opus-4-6"): (15.0, 75.0),
    ("anthropic", "claude-opus-4-7"): (15.0, 75.0),
    ("anthropic", "claude-sonnet-4-5"): (3.0, 15.0),
    ("anthropic", "claude-sonnet-4-6"): (3.0, 15.0),
    ("anthropic", "claude-haiku-4-5"): (0.80, 4.0),
    ("google", "gemini-2.5-pro"): (1.25, 10.0),
    ("google", "gemini-2.5-flash"): (0.30, 2.50),
    ("grok", "grok-4"): (5.0, 15.0),
    ("ollama", ""): (0.0, 0.0),  # local — free
}
_DEFAULT_RATE = (3.0, 15.0)  # Sonnet-ish if unknown


def _lookup_rate(provider: str, model: str) -> tuple[float, float]:
    if provider == "ollama":
        return (0.0, 0.0)
    rate = _RATES.get((provider, model))
    if rate is not None:
        return rate
    # Fallback: prefix match (e.g. "gpt-5-2024-...").
    for (p, m), r in _RATES.items():
        if p == provider and m and (model.startswith(m) or m.startswith(model)):
            return r
    return _DEFAULT_RATE


def _estimate_cost(req: CostEstimateRequest) -> CostEstimateResponse:
    spec_chars = len(req.specification)
    spec_tokens = max(1, spec_chars // 4)

    coders = [c for c in req.agent_configs if (c.get("agent_type") or "").lower() == "coder"]
    testers = [c for c in req.agent_configs if (c.get("agent_type") or "").lower() == "tester"]
    others = [
        c for c in req.agent_configs
        if (c.get("agent_type") or "").lower() not in ("coder", "tester")
    ]

    num_coders = max(1, len(coders))
    num_testers = max(0, len(testers))

    # Heuristic: per-iteration token volume.
    tokens_per_iter = (
        spec_tokens * num_coders * 5
        + spec_tokens * num_testers * 3
        + 1000  # summarizer/finalizer overhead
    )

    total_tokens = int(tokens_per_iter * req.max_iterations * 1.2)

    # Cost: split each agent's slice ~70% input / ~30% output.
    breakdown: dict[str, float] = {}
    total_cost = 0.0

    def _agent_cost(cfg: dict, iters: int, slice_tokens: int) -> tuple[str, float]:
        provider = (cfg.get("llm_provider") or "anthropic").lower()
        model = cfg.get("llm_model") or ""
        in_rate, out_rate = _lookup_rate(provider, model)
        in_tokens = int(slice_tokens * iters * 0.7)
        out_tokens = int(slice_tokens * iters * 0.3)
        cost = (in_tokens / 1_000_000) * in_rate + (out_tokens / 1_000_000) * out_rate
        return provider, cost

    for c in coders:
        slice_tokens = spec_tokens * 5
        provider, cost = _agent_cost(c, req.max_iterations, slice_tokens)
        breakdown[provider] = breakdown.get(provider, 0.0) + cost
        total_cost += cost
    for c in testers:
        slice_tokens = spec_tokens * 3
        provider, cost = _agent_cost(c, req.max_iterations, slice_tokens)
        breakdown[provider] = breakdown.get(provider, 0.0) + cost
        total_cost += cost
    for c in others:
        slice_tokens = max(500, spec_tokens // 2)
        provider, cost = _agent_cost(c, req.max_iterations, slice_tokens)
        breakdown[provider] = breakdown.get(provider, 0.0) + cost
        total_cost += cost

    # If no agent_configs supplied, fall back to total_tokens at default rate.
    if not req.agent_configs:
        in_rate, out_rate = _DEFAULT_RATE
        total_cost = (total_tokens * 0.7 / 1_000_000) * in_rate + (
            total_tokens * 0.3 / 1_000_000
        ) * out_rate
        breakdown = {"anthropic": round(total_cost, 4)}

    # Apply 20% overhead bump (matches total_tokens calc).
    total_cost = total_cost * 1.2

    # Time: roughly 2s per 1k output tokens + 5s per agent per iter.
    num_agents = max(1, num_coders + num_testers + len(others))
    time_seconds = int(total_tokens * 0.3 / 1000 * 2 + num_agents * req.max_iterations * 5)

    breakdown_rounded = {k: round(v, 4) for k, v in breakdown.items()}

    return CostEstimateResponse(
        estimated_tokens_per_iter=int(tokens_per_iter),
        estimated_total_tokens=total_tokens,
        estimated_cost_usd=round(total_cost, 4),
        estimated_time_seconds=time_seconds,
        breakdown=breakdown_rounded,
    )


@router.post("/cost-estimate", response_model=CostEstimateResponse)
async def cost_estimate(payload: CostEstimateRequest) -> CostEstimateResponse:
    """Rough cost / time forecast for a session before it starts."""
    return _estimate_cost(payload)
