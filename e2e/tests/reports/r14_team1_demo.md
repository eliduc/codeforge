# R14 Team 1 — Demo Player Wave 1–3 test report

**Target:** `https://stage.gotcode.ai`
**Spec file:** `e2e/tests/wave3-demo.spec.ts`
**Run command:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai npx playwright test tests/wave3-demo.spec.ts --reporter=list
```
**Run date:** 2026-05-13
**Result:** 14 / 14 tests failed — all fail at the auth gate (see "Blocking issue" below).

---

## Test cases written

| # | Title | Wave / priority | What it asserts |
|---|-------|-----------------|-----------------|
| 1 | Page loads and player initializes | — | `Tour` plaque text + `.react-flow` root visible after navigation. |
| 2 | Speed presets include 60× | Wave 1 P1·S | Exact-text buttons `0.5×`, `1×`, `2×`, `4×`, `8×`, `16×`, `60×` all visible. |
| 3 | Keyboard play/pause | Wave 1 P1·M | Body-level Space hotkey flips bottom play/pause button's `aria-label` between `Pause` and `Play` twice. |
| 4 | Keyboard seek End/Home | Wave 1 | Pressing `End` advances the clock display to ≥161s (duration=162); pressing `Home` resets to <1s. |
| 5 | Progress slider role and aria | Wave 1 P1·M | Bar has `role=slider`, `aria-valuemin=0`, `aria-valuemax=162`, `tabindex=0`, numeric `aria-valuenow`. |
| 6 | Progress slider keyboard seek | Wave 1 | Focus slider → `ArrowRight` advances clock by >3s; `ArrowLeft` decreases by >3s. |
| 7 | "What next" CTA appears after finish | Wave 1 P1·M | After `End`, the `[role=dialog][aria-label="What next"]` card surfaces with all four buttons (View final result / Try it yourself / Replay / Copy link). |
| 8 | Copy-link CTA copies URL | Wave 1 | Granted clipboard permissions; click `Copy link` → `navigator.clipboard.readText()` contains `/demo/mandelbulb`. |
| 9 | Try-it-yourself shows confirm dialog | Wave 1 P1·M | Top-bar button opens ConfirmDialog with `/start a real CodeForge session/`; Cancel closes it; URL unchanged. |
| 10 | Iframe sandbox is tight | Wave 3 P2·S | After demo finishes, switch to Final result tab; the rendered `iframe[title="Demo final result"]` has `sandbox` containing `allow-scripts` and NOT `allow-same-origin`. |
| 11 | Skip-to-result button | Wave 3 P2·S | Early in playback (`clock<20`), switching to Final result shows placeholder with `Skip to result` button; clicking it surfaces the iframe. |
| 12 | Mobile drawer at narrow viewport | Wave 2 P1·L | `375×667` viewport: no 300-px aside; `Tour` toggle button visible; tapping it opens the `[aria-label="Tour narration"]` drawer. |
| 13 | Spec card per-template namespacing | Wave 3 P3·S | Collapse spec on mandelbulb → navigate to crystal (expanded) → return to mandelbulb (still collapsed). |
| 14 | Continue button hidden mid-chapter | Wave 2 P1·M | Continue visible while paused on first chapter, hidden after clicking through and clock passes ~5s. |

---

## Initial run results

```
14 failed
  1.  Page loads and player initializes
  2.  Speed presets include 60× (Wave 1)
  3.  Keyboard play/pause (Wave 1 P1·M)
  4.  Keyboard seek End/Home (Wave 1)
  5.  Progress slider role and aria (Wave 1 P1·M)
  6.  Progress slider keyboard seek (Wave 1)
  7.  "What next" CTA appears after finish (Wave 1 P1·M)
  8.  Copy-link CTA copies URL
  9.  Try-it-yourself shows confirm dialog (Wave 1 P1·M)
  10. Iframe sandbox is tight (Wave 3 P2·S)
  11. Skip-to-result button (Wave 3 P2·S)
  12. Mobile drawer at narrow viewport (Wave 2 P1·L)
  13. Spec card per-template namespacing (Wave 3 P3·S)
  14. Continue button hidden mid-chapter (Wave 2 P1·M)
```

Every test errors with:
```
Locator: locator('text=/Tour/i').first()
Expected: visible
Timeout: 20000ms
```

The Playwright snapshot at failure time shows the **login form** instead of the demo player.

---

## Blocking issue (root cause of all 14 failures)

The task brief states that `/demo-player/mandelbulb` is **anonymous**, but:

1. **Route name mismatch** — the real path is `/demo/:templateId`, not `/demo-player/:templateId`
   (`frontend/src/App.tsx:36`, `frontend/src/pages/DemoPlayerPage.tsx:10`). The test file uses the
   real path `/demo/mandelbulb`.
2. **Auth gate** — `<Route path="*">` is wrapped in `<RequireAuth>` (App.tsx:25–50), so
   `/demo/:templateId` falls inside the protected sub-tree. Anonymous visits redirect to
   `/login`. The DemoGallery's "Try it yourself" CTA also implies the gallery is post-auth.

Together these mean **no anonymous test can reach the demo player on stage**. The 14 spec
bodies are correct (verified by code review of `DemoPlayerPage.tsx` and `useTimelinePlayer.ts`),
but they cannot execute until either:

- the `/demo/:templateId` route is moved OUTSIDE `<RequireAuth>` (so anonymous demo discovery
  works as the marketing copy suggests), OR
- the e2e harness gains an auth fixture that performs OTP login before the test body.

Both options are **out of scope for Team 1** (Test-Writer phase). I have flagged this as the
top item for Team 3.

---

## Skipped / fixme reasoning

No tests are `test.fixme` in the current file. All 14 are written as fully-runnable specs against
the assumed anonymous demo route. Once the auth-gate / public-demo decision is made by Team 3,
tests will either:

- Pass as-is if `/demo/:templateId` becomes anonymous, or
- Need a shared `beforeEach` auth setup added — which I deliberately did NOT add per the rule
  "Each test independent".

---

## Notes for Team 3 (downstream fix)

1. **Path naming** — Either expose a `/demo-player/:id` alias (matches DemosPage marketing
   verbiage) or update the task brief; the file is currently using the real path `/demo/:id`.
2. **Auth gate** — Decision required: should the Demo Player be a public landing surface
   (consistent with the "Try it yourself" CTA inside it that prompts session creation)?
   If yes, hoist the route above `<RequireAuth>`; if no, wire an e2e auth fixture.
3. **Speed-preset assertion (Test #2)** uses exact-text matching to avoid matching `10×`
   (substring of `60×` is fine, but `1×` would substring-match `10×` etc.). If a future preset
   row gets re-rendered with concatenated text, the assertion may need an explicit container
   scope.
4. **Test #8 (clipboard)** grants `clipboard-read` + `clipboard-write` in the BrowserContext;
   this only works on Chromium (the only project in `playwright.config.ts`).
5. **Test #13 (template namespacing)** depends on `cf_demo_spec_collapsed_${templateId}`
   localStorage namespacing introduced in Wave 3 P3·S. localStorage is preserved across
   `page.goto()` within the same context, which is what enables the assertion.
