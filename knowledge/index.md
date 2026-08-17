---
type: index
title: CodeForge Knowledge Base
description: Curated, durable engineering knowledge for CodeForge in Open Knowledge Format (OKF v0.1). Read this to rehydrate project context in a fresh session instead of replaying the transcript.
tags: [okf, index]
timestamp: 2026-07-11T00:00:00Z
---
# CodeForge Knowledge Base (OKF)

Markdown + YAML-frontmatter knowledge, consumable by humans and AI agents. Links
between files form the relationship graph. This is **not a transcript** — it is the
distilled "how / why" that outlives any single change.

## Domains
- [Architecture](architecture/index.md) — how subsystems work.
- [Conventions](conventions/index.md) — team / agent workflows (КАО).
- [Operations](operations/index.md) — deploy + incident runbooks.
- [Integrations](integrations/index.md) — external services.

## Where knowledge lives
| Store | Holds |
|-------|-------|
| **`knowledge/` (this tree)** | durable how/why that outlives changes |
| **Git history + `КАО#<id>` tags** | what changed, when, and why (per commit) |
| **`~/.claude/projects/.../memory/`** | cross-session agent memory (same md+frontmatter shape) |
| **`CLAUDE.md`** | rules the agent must follow |

## Note on OKF and context compaction
OKF does **not** stop `/compact` — compaction is a property of the model's finite
context window, which raw conversation fills regardless of on-disk files. What this
tree does: make compaction **lossless** (durable facts survive on disk) and make
rehydration **cheap** (a fresh session reads the relevant curated file + index, not
the whole history).
