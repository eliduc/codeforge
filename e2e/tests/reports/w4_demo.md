# Wave-4 — Demo Tester report

**Scope:** Extended Demo Player coverage that complements (does NOT replace)
`wave3-demo.spec.ts` and `wave4-anonymous.spec.ts`.

**Spec file:** `e2e/tests/wave4-demo.spec.ts` (14 cases)
**Stage URL:** `https://stage.gotcode.ai`
**Run command:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
  npx playwright test tests/wave4-demo.spec.ts --reporter=list
```

## Run result

| Metric  | Count |
|---------|-------|
| Total   | 14    |
| Passed  | 12    |
| Failed  | 0     |
| Skipped | 2 (1 auth-gated, 1 documented `test.fixme`) |
| Duration | ~2m12s |

## Cases

### Multi-template playback (Wave 1 P1·M)

| ID | Case | Result |
|----|------|--------|
| 1 | `/demo/mandelbulb` loads (graph + title + Try-it button + Demo badge) | passed |
| 2 | `/demo/snake` loads (graph + title + Try-it button + Demo badge) | passed |
| 3 | `/demo/particles` loads (graph + title + Try-it button + Demo badge) | passed |
| 4 | `/demo/crystal` loads (graph + title + Try-it button + Demo badge) | passed |
| 5 | narration_chapters presence — mandelbulb shows ChapterSidePanel + Continue; crystal / particles / snake fall back to StatusPlaque (no chapter Continue) | passed |

### `/demos` gallery (Wave 1 P1·S + R14-FIX-01)

| ID | Case | Result |
|----|------|--------|
| 10 | "Real multi-agent runs, replayed" header copy visible | passed |
| 11 | `/demos` renders for **authenticated** users (PublicChrome → full Layout) — Featured Demos + 4 cards | passed |
| 11b | `/demos` still renders **anonymously** — 4 cards present | passed |

### Keyboard-shortcut edge cases (Wave 1 P1·M)

| ID | Case | Result |
|----|------|--------|
| 13 | Space inside ConfirmDialog does NOT toggle play/pause | **skipped** (auth-only; no `E2E_AUTH_TOKEN`) |
| 14 | End seeks to duration; subsequent → arrow does NOT advance past `duration_seconds` (Math.min clamp) | passed |
| 15 | Home seeks to 0; subsequent ← arrow stays at 0 (Math.max(0,…) clamp) — no negative clock | passed |

### URL params

| ID | Case | Result |
|----|------|--------|
| 16 | `?startAtChapter=2` — **NOT** currently supported | **skipped (`test.fixme`)** — see Findings below |

### Chapter narration completeness

| ID | Case | Result |
|----|------|--------|
| 17 | mandelbulb timeline JSON has 14 chapters, each with non-empty `title` + non-empty `paragraphs` array (no empty bodies) | passed |

### Speed control persistence

| ID | Case | Result |
|----|------|--------|
| 18 | Selecting 4× then reloading reverts to 1× (NOT persisted by design); no `*speed*` key in localStorage | passed |

## Findings

- **Per-template narration_chapters status (Wave 3 P2·S confirmed):**
  - `mandelbulb.json` → 14 chapters → renders `<ChapterSidePanel>` (left aside) with auto-pause and `▶ Continue` CTA.
  - `crystal.json`, `particles.json`, `snake.json` → 0 chapters → falls back to `<StatusPlaque>` (no chapter pause, no Continue button). The DemoPlayerPage guard at line 854 is correct:
    `{(!timeline.narration_chapters || timeline.narration_chapters.length === 0) && <StatusPlaque … />}`.

- **`?startAtChapter=N` URL param is NOT wired.**
  Source inspection: neither `frontend/src/pages/DemoPlayerPage.tsx` nor `frontend/src/hooks/useTimelinePlayer.ts` reads `useSearchParams` / `startAtChapter`. The hook accepts only `{ timeline, autoPlay }`. Test 16 is `test.fixme`'d so if/when this is implemented, the assertion (`clock > 5` after navigating with `?startAtChapter=2`) will be enforced.

- **Speed is intentionally non-persistent.**
  `useTimelinePlayer` initialises `useState(1)` for speed; there's no `localStorage` read/write. Confirmed by absence of any `speed` key in `localStorage` after reload, and by clock-delta probe (≈1× rate, not 4×).

- **Keyboard handler clamping is correct.**
  `seekTo(Math.min(timeline.duration_seconds, state.clock + 5))` (line 553) and
  `seekTo(Math.max(0, state.clock - 5))` (line 549) — verified by end-to-end behavior.

- **Cases deliberately NOT duplicated from sister specs:**
  - Iframe sandbox → `wave3-demo.spec.ts` test 10
  - Skip-to-result → `wave3-demo.spec.ts` test 11
  - Mobile drawer at 375×667 → `wave3-demo.spec.ts` test 12
  - Spec card per-template namespacing → `wave3-demo.spec.ts` test 13
  - Continue button hidden mid-chapter → `wave3-demo.spec.ts` test 14
  - Try-it-yourself anonymous → /login → `wave3-demo.spec.ts` test 9b + `wave4-anonymous.spec.ts` B5
  - PublicChrome Sign-in link → `wave4-anonymous.spec.ts` B3 / B4
  - Demo gallery basic card navigation + descriptions → `wave4-anonymous.spec.ts` C1 / C2 / C4

## No bugs filed

Per the brief — Demo Tester documents observations only; bug fixes are out of scope.
All 12 executed cases pass on stage. The 2 skipped cases are gated (auth) or
documenting a known-unimplemented feature (`?startAtChapter`).
