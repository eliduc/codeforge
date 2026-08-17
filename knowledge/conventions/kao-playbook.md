---
type: convention
title: КАО Playbook
description: The КАО (команда агентов-отладчиков) cycle — an exhaustive multi-agent audit-and-fix loop run to green, triggered by "запусти команду агентов" / "КАО".
tags: [kao, testing, workflow]
resource: .claude/skills/kao/SKILL.md
timestamp: 2026-07-11T00:00:00Z
---
# Trigger
Chat phrases: "запусти команду агентов", "запусти агентов", "КАО", "команда агентов".
Round scope defaults to the **whole app** if unspecified.

# Cycle
1. **Test-writers** (3 parallel sub-teams, findings merged): UI/UX (Playwright,
   visual-regression, Lighthouse/Axe, RTL), Functionality (backend pytest + sandbox
   + frontend vitest), Security (4 classes: auth/authz/IDOR, input/injection,
   dependency CVEs, secret/config leaks).
2. **Testers** — run the merged pool, classify **critical / serious / minor /
   suggestion**, and **adversarially verify** each finding (try to refute; keep only
   independently-confirmed).
3. **Fixers** — main agent fixes confirmed findings itself, tags `КАО#<id>`, deploys
   to stage. Control returns to Testers (never trust the fixer's self-report).

Loop Testers → Fixers → Testers until **0/0/0/0** in the round's scope.

# Rules
- **0/0/0/0** (zero critical/serious/minor/suggestion) is the exit bar.
- **Pre-existing / large / risky** items → separate task, do NOT block the round.
- Every fix tagged `КАО#<id>` in code AND commit message.
- **Non-Degradation Rule** (see `CLAUDE.md`): no change silently removes/breaks/degrades
  existing behavior; unavoidable impact → warn + get approval first.
- Deploy to **stage** + independent verify. Commit/push and **prod** only on explicit
  user request; before a prod backend restart, gate on 0 live sessions.

# Execution pattern that works
Orchestrate with the Workflow tool: Audit phase (~8 parallel auditors by dimension,
structured findings) → Verify phase (adversarial per-finding) → Classify. Fixers =
main agent. Then a SECOND workflow re-verifies each fix + hunts regressions. Demo
runtime (Watch/Try, browser behaviour) is checked LIVE in a browser — subagents can't.

# See also
- [Durable deploy](../operations/durable-deploy.md)
