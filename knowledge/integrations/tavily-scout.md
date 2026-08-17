---
type: integration
title: Tavily Model Scout
description: How CodeForge uses the Tavily web-search API to detect models announced ahead of the vendor /v1/models API, and the key situation behind it.
tags: [tavily, search, llm, discovery, kao-r6]
resource: backend/app/services/tavily_scout.py
timestamp: 2026-07-11T00:00:00Z
---
# Purpose
Augment vendor-API model discovery: Tavily searches each vendor's own documentation
domains and extracts candidate model IDs, so [discovery](../architecture/llm-provider-discovery.md)
can flag models **announced but not yet in the API** (e.g. `grok-4.5`). It never offers
a non-API model as directly usable — the vendor `/v1/models` remains the source of exact
IDs ("Tavily + validate against API").

# Key situation (important)
- The Tavily available to Claude in-session is a **hosted claude.ai MCP connector**; its
  credential is managed by Anthropic and is **NOT extractable** as a `tvly-` key for the
  app backend. Do not go hunting on disk for one — there is no reusable raw key from that.
- The CodeForge backend uses its **own** `TAVILY_API_KEY` (SecretStr in
  [config.py](../../backend/app/core/config.py), field `tavily_api_key`), optional and
  **gated**: unset → the scout is disabled and discovery falls back to vendor APIs only.
- Free tier at tavily.com (~1000 req/mo). Put the key in `.env` (gitignored) locally and
  in `~/codeforge-stage/.env` / `~/codeforge/.env` on the server; recreate the backend to
  pick it up (see [durable deploy](../operations/durable-deploy.md)).

# How the scout works
`POST https://api.tavily.com/search` with `{api_key, query, search_depth:"advanced",
include_domains:[vendor docs], max_results}`. Per-vendor recipe = (query, doc domains,
model-ID regex). Extracted IDs are noise-filtered, then the discovery service keeps only
those whose parsed version is strictly newer than the current API max (version cap
`0 < v < 100` rejects date/artefact numbers). Best-effort: any error → empty list.

# See also
- [LLM provider discovery](../architecture/llm-provider-discovery.md)
