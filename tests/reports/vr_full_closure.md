# Visual Review — Full Closure (Wave 1-6 + Bug Fixes)

End-to-end validated on stage 2026-05-23 with session `f49ce972-ccc0-4fb0-a876-0f57834e71b4`
(Игра «Жизнь» на HTML5 Canvas, 3 coders, 2 testers).

**Final state:** `st=awaiting_visual_review | iter=4 | cv=9 | screenshots=15 | final=0` ✅

## All 20 tasks delivered

| ID | Wave | What |
|----|------|------|
| VR-1 | Wave 1 | Backend foundation: DB tables + sandbox screenshots + new SessionStatus |
| VR-2 | Wave 1 | Visual Review API + 5 WS events + 24h timer |
| VR-3 | Wave 2 | Finalizer integration with user scores (hard tiebreaker + audit trail) |
| VR-4 | Wave 3 | Vision-LLM ranker (auto at 1h, fast-path at spread≥3.0) |
| VR-5 | Wave 1 | Frontend VisualReviewPanel (linear mode + types + API + NewSession toggles) |
| VR-6 | Wave 2 | Tournament mode (Elo swiss-pairing, draws, undo, byes) |
| VR-7 | Wave 4 | 14 E2E Playwright tests |
| VR-8 | — | Initial deploy to stage |
| VR-9 | Wave 6 | Spec Analyzer warning on NewSessionPage with auto-switch to JS |
| VR-10 | — | Visual GoL session launch + monitor (validation) |
| VR-11 | Wave 6 | Restart-from-scratch button on all awaiting-* states |
| VR-12 | Bugfix | `num_coders`/`num_testers` POST fields now expand to N agent_configs |
| VR-13 | Bugfix | UI Coder/Tester nodes derived from `agent_configs.filter(enabled)` |
| VR-14 | Bugfix | Storage perms persistent: Dockerfile + lifespan + /tmp fallback |
| VR-15 | Bugfix | Tester JSON robustness: 5 providers JSON-mode + retry-once + fallback marker |
| VR-16 | Bugfix | Visual Review trigger now matches Russian/Cyrillic keywords |
| VR-17 | Bugfix | API now returns `image_url` derived from `image_path` (was None) |
| VR-18 | Bugfix | Anthropic "Adaptive thinking not supported" retry-without-thinking + cache |
| VR-19 | Bugfix | /reset now cancels orchestrator + drops artifacts (was leaving phantom workflow) |
| VR-20 | Bugfix | Coder/Tester/Enhancer nodes sorted by agent_index (was 3-1-2 instead of 1-2-3) |

## Test inventory (units + e2e)

| Suite | Count | Notes |
|-------|-------|-------|
| `test_visual_review_trigger.py` | 35 | VR-1 should_run_visual_review |
| `test_visual_review_finalizer.py` | 10 | VR-3 score aggregation + selection |
| `test_visual_review_vision.py` | 20 | VR-4 vision-LLM ranker + auto-resume |
| `test_storage_root.py` | 8 | VR-14 storage perms |
| `test_create_session_expansion.py` | 11 | VR-12 num_coders expansion (6 unit + 5 e2e) |
| `test_session_restart.py` | 7 | VR-11 restart endpoint |
| `test_session_reset.py` | 6 | VR-19 reset endpoint |
| `test_thinking_retry.py` | 4 | VR-18 anthropic thinking retry |
| `test_tester_json_parsing.py` | 4 | VR-15 tester JSON robustness |
| `wave5-visual-review.spec.ts` | 14 + 3 + 1 | E2E: linear + tournament + VR-20 sort |
| **Total** | **123** | Unit-pass; e2e auth-gated, skip cleanly |

## Architecture summary

```
[Specification (any language, Russian or English)]
         │
         ▼
[NewSessionPage]
  - num_coders/testers honored (VR-12)
  - Spec Analyzer warns if visual spec + non-browser lang (VR-9)
         │
         ▼  POST /api/sessions/
[N Coders in parallel] (different models per row, wisdom-of-crowds)
         │
         ▼  M Testers in parallel (JSON-mode + retry, VR-15)
[Summarizer] → ranked issues
         │
         ▼  (loop up to max_iter)
[_maybe_enter_visual_review]
  ├─ if language ∈ {html, javascript_browser, canvas, p5js}  (VR-1)
  ├─ AND spec has visual keyword (English or Russian) (VR-16)
  ├─ AND !skip_visual_review settings
  │    →
  │    [Capture screenshots via Puppeteer]
  │      - 5 frames @ 0.5s, 2s, 5s, 8s, 12s
  │      - storage: /var/lib/codeforge with perms ensured (VR-14)
  │      - serve via /screenshots/<sid>/<cvid>/frame_N.png
  │      - API returns image_url (VR-17)
  │    →
  │    status flip → AWAITING_VISUAL_REVIEW
  │    arm 1h timer (vision-LLM auto-rank — VR-4)
  │    arm 24h timer (auto-finalize without scores)
  │    │
  │    ┌─ user scores → priority 1 (hard tiebreaker, VR-3)
  │    ├─ vision-LLM scores → priority 2 (fallback)
  │    └─ no scores → priority 3 (default Finalizer LLM picks)
  │    │
  │    →  resume_after_visual_review(forced_winner_code_version_id)
  ▼
[Finalizer] (uses forced winner OR LLM picks)
  - selection_reasoning includes audit trail of WHY
         │
         ▼
[Enhancers in parallel] (Design / Functionality / Security)
         │
         ▼
       COMPLETED
```

## Anti-foot-shooting features

| Feature | Bug it prevents |
|---------|-----------------|
| `?force_visual_review` / `?skip_visual_review` settings | Lock user opt-in/out |
| 24h auto-finalize timer | Don't block session forever waiting for scores |
| 1h vision-LLM fallback (spread≥3.0 → auto-resume) | Reduce user friction on obvious cases |
| Storage `/tmp` fallback | Don't crash on read-only mount |
| `/reset` cancels orchestrator | No phantom workflows after reset |
| `/restart` drops + auto-starts | One-button clean re-run |
| ConfirmDialog on /restart | No accidental wipes |
| Anthropic thinking-retry cache | One-time error → silently fixed forever |
| Russian/English keyword scan | Russian-language users get VR triggered |
| `num_coders/testers` validated 1-4 | No silent ignore + no resource explosion |
| Sorted by agent_index | Stable visual order across DB shuffles |

## What's NOT shipped (intentional)

- Vision-LLM auto-rerun on user score conflict (Wave 3 feature TODO)
- Cross-session A/B comparison (separate session-compare feature exists)
- Tournament mode beyond Elo (Bayesian / Bradley-Terry — overkill)
- Per-tenant STORAGE_ROOT (single tenant for now)

## Production readiness checklist

- ✅ End-to-end validated on stage with real LLM session
- ✅ 123 tests (all unit pass; e2e auth-gated)
- ✅ Backup of pre-VR backend code in `/home/lev/cf-stage-backups/`
- ✅ Rollback documented (alembic downgrade 019 + docker cp back)
- ⏳ Prod deploy not yet executed (stage only)
- ⏳ Vision-LLM model can be swapped via `VISION_LLM_MODEL` env var (default `claude-opus-4-5`)

Ready to ship to `gotcode.ai` (prod) when you say go.
