# Round 13 — Team 3 (bug fixers) report

**Date:** 2026-05-13
**Scope:** Fix R13-BUG-01 (HIGH) — demo-player elapsed timer reads `T:29644297:XX`.

---

## 1. Bug fixed

### R13-BUG-01 — HIGH — Demo-player elapsed timer regression

**Root cause** (per Team 2 findings):
`frontend/src/hooks/useTimelinePlayer.ts:274` used `performance.now()` (monotonic clock from page load, value ≈ a few thousand ms) and assigned it to `startedAt`. `AgentNode.tsx:287` then computes elapsed as `(Date.now() - startedAt) / 1000`, mixing wall-clock and monotonic clocks → ~1.78×10⁹ s → `T:29644297:XX`.

**Reference contract:** `SessionDetailPage.tsx:2126` uses `activeSince: Date.now()` for real sessions. The demo path must match.

### File modified

`frontend/src/hooks/useTimelinePlayer.ts`

### Exact diff

```diff
--- a/frontend/src/hooks/useTimelinePlayer.ts
+++ b/frontend/src/hooks/useTimelinePlayer.ts
@@ -271,7 +271,7 @@
 
   // Apply a single timeline event into the state.
   const applyEvent = useCallback((ev: TimelineEvent) => {
-    const now = performance.now()
+    const now = Date.now()
     if (ev.type === 'workflow_started') {
       setWorkflow(w => ({ ...w, status: 'running' }))
     } else if (ev.type === 'iteration_started') {
```

One-line change. `now` is only consumed at line 285 (`startedAt: now`) — no other site is affected.

---

## 2. Local verification

### TypeScript AST check
```
cd frontend && npx tsc --noEmit
exit=0  (clean)
```

### R13 frontend tests
```
cd frontend && node --experimental-strip-types --test tests/test_round13_timeline_player.mjs
# tests 23
# pass 23
# fail 0
# duration_ms 77.6489
```
**23 / 0 / 0** — no regression. ✅

---

## 3. Stage deploy

| Item | Value |
|---|---|
| Deploy timestamp (UTC) | **2026-05-13T07:42:54Z** |
| Bundle hash BEFORE | `index-B8N2Iogq.js` |
| Bundle hash AFTER  | `index-DMMQI6HA.js` |
| `https://stage.gotcode.ai/health` after deploy | **200 OK** |

Deploy commands executed:
```
scp frontend/src/hooks/useTimelinePlayer.ts miniblack:/home/lev/codeforge-stage/frontend/src/hooks/useTimelinePlayer.ts
ssh miniblack "cd ~/codeforge-stage && docker compose build frontend && docker compose up -d frontend"
```
Build completed cleanly; frontend container recreated and Started.

---

## 4. Live browser verification (chrome-devtools)

Steps:
1. Minted JWT on stage for `r13-team3-9be6e1c3@example.com` via `app.api.auth.create_jwt_token(...)` inside the stage backend container.
2. Injected token into `localStorage['codeforge_token']` on `https://stage.gotcode.ai/`.
3. Navigated to `https://stage.gotcode.ai/demo/mandelbulb` (viewport 1200×800).
4. Clicked the `▶ Continue` button once to advance into chapter "Coding round 1 — two coders in parallel".
5. Waited ~5 s of simulation time so both Coder nodes were active and streaming.
6. Captured screenshot.

### Screenshot
`tests/reports/round13_bug01_fix_verify.png`

### Elapsed-timer reading on active coders (POST-FIX)
From the post-Continue a11y snapshot (matched against the screenshot):
- **Coder 1** (claude-opus-4.5, `Coding...`, STREAMING) → `T: 0:05` (uids 4_18 + 4_19)
- **Coder 2** (gpt-5.1-codex,  `Coding...`, STREAMING) → `T: 0:05` (uids 4_24 + 4_25)

Both chips now show the expected `MM:SS` ≈ 5 seconds elapsed — **sensible value**, matches the simulator clock reading `20.0s` at the bottom (Coders started ~15 s of timeline time after the chapter Continue, then ran for ~5 s real time). No more `T:29644297:XX`.

Reference (broken pre-fix value): Team 2 observed `T:29644297:03` / `T:29644297:02` on the same chapter under the previous bundle. → **REGRESSION RESOLVED**. ✅

---

## 5. Summary

- File modified: `frontend/src/hooks/useTimelinePlayer.ts` (1 line: `performance.now()` → `Date.now()`)
- AST: `tsc --noEmit` exit 0 ✅
- R13 player tests: 23 / 0 / 0 ✅
- Deployed to stage at 2026-05-13T07:42:54Z; bundle hash changed `B8N2Iogq` → `DMMQI6HA`; `/health` = 200 ✅
- Live verify: both active Coders show `T:0:05` instead of `T:29644297:XX` ✅
- Constraints respected: only the single hook line was touched; no prod deploy.

## Team 3 status: FIX APPLIED — HANDOFF TO TEAM 2 FOR VERIFY
