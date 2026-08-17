---
type: architecture
title: LLM Provider Model Discovery
description: How CodeForge enumerates each vendor's current models for the picker and the "Refresh models" button, and how background "new model" detection works.
tags: [llm, providers, discovery, kao-r6]
resource: backend/app/llm/providers/
timestamp: 2026-07-11T00:00:00Z
---
# Golden rule
Discovery reads the vendor `/v1/models` API and surfaces **all** current models.
**Never hardcode family / version / variant names** — a hardcoded list silently
drops new models. Two real bugs from this class (КАО#R6): `claude-fable-5` (a new
Anthropic family) and `gpt-5.6-sol` (a same-version named variant) were both
returned by the API but dropped by the discovery filter.

# Per-provider slot logic
Each provider parses model IDs into a slot; the newest / cleanest ID per slot wins.
- **OpenAI** ([openai_provider.py](../../backend/app/llm/providers/openai_provider.py)):
  slot = (`gpt-<major>.<minor>` or `o<major>`, **variant**). The variant suffix is a
  generic `[a-z]+` capture (letters only), so `gpt-5.6-luna` / `gpt-5.6-sol` /
  `gpt-5.6-terra` each get a distinct slot instead of collapsing. Dated snapshots
  `-YYYY-MM-DD` (and `-YYYYMMDD`) are lower priority → collapse to the clean alias.
  Floor: gpt `major < 4` and o-series `major < 3` are dropped as obsolete.
- **Anthropic** ([anthropic_provider.py](../../backend/app/llm/providers/anthropic_provider.py)):
  family name is a generic `[a-z]+` capture (was hardcoded `opus|sonnet|haiku`, which
  dropped `fable`). Keyed by `{family}-{major}.{minor}`; families < 4 skipped.
- **Google**: slot = (version_float, tier). Already version-keyed (fine).
- **Grok**: slot = (version, tier, qualifier). Already version-keyed (fine).

# Downstream
`AVAILABLE_MODELS` (config) is only a fallback. Capabilities/pricing are predicate-
based on the model string, so surfacing more models does not break them.

# Background "new models available" (КАО#R6, Part 2)
- [model_discovery.py](../../backend/app/services/model_discovery.py): diff current
  vendor-API lineup vs a stored **baseline** (`AppSetting` key `model_discovery_state`)
  → genuinely new usable models. Baseline lazy-inits on first run (no false "all new").
  Vendor-API and Tavily lookups are TTL-throttled.
- **Announced ahead of API**: [Tavily scout](../integrations/tavily-scout.md) surfaces
  candidates whose version is *strictly newer* than the API max (e.g. `grok-4.5` when
  the API tops out at `grok-4.3`). A version sanity-cap (`0 < v < 100`) rejects
  date/artefact-derived numbers. Announced items can't enter the baseline, so an
  `announced_seen` set (recorded on acknowledge) stops them re-nagging.
- Endpoints: `GET /api/settings/models/check-updates`, `POST .../acknowledge`.
- Frontend: `useModelUpdateNotifier` raises a toast on app entry — "Load latest"
  (refresh + acknowledge) / "Dismiss" (acknowledge).

# See also
- [КАО playbook](../conventions/kao-playbook.md)
- [Tavily scout](../integrations/tavily-scout.md)
