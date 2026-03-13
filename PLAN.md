# Plan: Update Models & Add Thinking Effort Support

## Research Summary — Top Models per Provider (Feb 2026)

### Anthropic
| Model | API ID | Thinking | Effort values | Pricing (in/out per 1M) |
|-------|--------|----------|---------------|------------------------|
| Claude Opus 4.6 | `claude-opus-4-6` | adaptive | `low`, `medium`, `high`(default), `max`(Opus only) | $5/$25 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | adaptive | `low`, `medium`, `high`(default) | $3/$15 |

**API format:**
```python
thinking={"type": "adaptive"}
output_config={"effort": "high"}  # optional
```
**Note:** `type: "enabled"` + `budget_tokens` is deprecated on 4.6. Older models (4.5) still need it.

### OpenAI
| Model | API ID | Reasoning | Effort values | Pricing (in/out per 1M) |
|-------|--------|-----------|---------------|------------------------|
| GPT-5.2 | `gpt-5.2` | yes | `none`(default), `low`, `medium`, `high`, `xhigh` | $2.50/$10 |
| GPT-5-mini | `gpt-5-mini` | yes | `none`(default), `low`, `medium`, `high` | $0.40/$1.60 |

**API format:**
```python
reasoning={"effort": "medium"}  # in chat completions
```
**Note:** When reasoning != "none", temperature/top_p are unsupported.

### Google
| Model | API ID | Thinking | Effort param | Pricing (in/out per 1M) |
|-------|--------|----------|-------------|------------------------|
| Gemini 2.5 Pro | `gemini-2.5-pro` | yes | `thinking_budget`: -1(auto), 0(off), 128-32768 | $1.25/$5 |
| Gemini 2.5 Flash | `gemini-2.5-flash` | yes | `thinking_budget`: -1(auto), 0(off), 128-32768 | $0.15/$0.60 |

**API format:**
```python
config=types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(thinking_budget=1024)
)
```

### xAI (Grok)
| Model | API ID | Reasoning | Effort param | Pricing (in/out per 1M) |
|-------|--------|-----------|-------------|------------------------|
| Grok 4 | `grok-4-0709` | built-in | none (always on) | $3/$15 |
| Grok 4.1 Fast | `grok-4-1-fast-reasoning` | built-in | none (always on) | $0.20/$0.50 |
| Grok Code Fast | `grok-code-fast-1` | built-in | none (always on) | $0.20/$1.50 |

**Note:** Grok reasoning models have thinking built-in with no API-level effort control.

---

## What Changes

### 1. `anthropic_provider.py`
- Add 4.6 family to `CODE_MODELS`, `PRICING`, `THINKING_MODELS`, `MAX_OUTPUT_TOKENS`
- Add `opus-4-6`, `sonnet-4-6` to model family detection in `is_available()`
- Update `generate()`: for 4.6 models use `thinking={"type": "adaptive"}` + `output_config={"effort": <value>}`; for older models keep `type: "enabled"` + `budget_tokens`
- New param: `thinking_effort: str | None = None` (values: `low`, `medium`, `high`, `max`)

### 2. `openai_provider.py`
- Clean up `CODE_MODELS` to current top models: `gpt-5.2`, `gpt-5-mini`
- Ensure `reasoning_effort` param flows through (already partially implemented)
- Update `_generate_chat_completions`: pass `reasoning={"effort": value}` for GPT-5.x models
- Add GPT-5.2 to `REASONING_MODELS` check (GPT-5.x supports reasoning.effort even though it's not o-series)

### 3. `google_provider.py`
- Clean up `CODE_MODELS` to: `gemini-2.5-pro`, `gemini-2.5-flash`
- Update `generate()`: accept `thinking_budget: int | None` param and pass as `ThinkingConfig(thinking_budget=N)` instead of hardcoded 8000
- Map our unified thinking_effort to budget: `low`→1024, `medium`→4096, `high`→8000, `max`→24576

### 4. `grok_provider.py`
- Clean up `CODE_MODELS` to current top models: `grok-4-0709`, `grok-4-1-fast-reasoning`, `grok-code-fast-1`
- No thinking effort changes needed (reasoning is built-in, no API knob)

### 5. `base.py` (BaseLLMProvider)
- Add `thinking_effort` to `generate()` signature: `thinking_effort: str | None = None`

### 6. `router.py` (LLMRouter)
- Add `thinking_effort` param to `generate()` and pass via `**kwargs` to provider

### 7. `agents/base.py` (BaseAgent._call_llm)
- Add `thinking_effort` to `_call_llm()` and pass through to router

### 8. Agent config / schema
- **NOT in this PR** — thinking_effort is decided per-provider and auto-enabled. Future work can add per-agent config.

---

## Unified thinking_effort values

All providers map to a unified set: `"low"`, `"medium"`, `"high"` (default when thinking on), `"max"`.

| Unified | Anthropic 4.6 | OpenAI GPT-5.2 | Google 2.5 | Grok |
|---------|--------------|----------------|------------|------|
| `low` | effort="low" | effort="low" | budget=1024 | n/a |
| `medium` | effort="medium" | effort="medium" | budget=4096 | n/a |
| `high` | effort="high" | effort="high" | budget=8000 | n/a |
| `max` | effort="max" (Opus only) | effort="xhigh" | budget=24576 | n/a |
| `none`/null | omit thinking | effort="none" | budget=0 | n/a |

---

## Files to change (in order)

1. `backend/app/llm/base.py` — add `thinking_effort` to abstract `generate()`
2. `backend/app/llm/providers/anthropic_provider.py` — models + adaptive thinking
3. `backend/app/llm/providers/openai_provider.py` — models + reasoning effort
4. `backend/app/llm/providers/google_provider.py` — models + thinking_budget
5. `backend/app/llm/providers/grok_provider.py` — models cleanup
6. `backend/app/llm/router.py` — pass `thinking_effort` through
7. `backend/app/agents/base.py` — pass `thinking_effort` through `_call_llm()`
