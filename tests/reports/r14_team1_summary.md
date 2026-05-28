# КАО R14 — Team 1 (Test Writers) — Summary

5 параллельных агентов написали **63 Playwright-теста** в `e2e/tests/wave3-*.spec.ts`.

## Run results против `https://stage.gotcode.ai` (без auth-токена)

| Спека | Кейсов | Passed | Skipped (auth) | fixme | Failed |
|-------|--------|--------|----------------|-------|--------|
| `wave3-auth.spec.ts` | 10 | 4 | — | 6 | 0 |
| `wave3-demo.spec.ts` | 14 | 0 | 14 | 0 | 0 |
| `wave3-sessions.spec.ts` | 13 | 1 | 12 | 0 | 0 |
| `wave3-foundation.spec.ts` | 15 | 0 | 11 | 4 | 0 |
| `wave3-live.spec.ts` | 11 | 1 | 10 | 0 | 0 |
| **Итого** | **63** | **6** | **47** | **10** | **0** |

84% тестов заблокированы auth-gating'ом (нужен `E2E_AUTH_TOKEN`). 0 настоящих failures на тестах, которые смогли выполниться.

## Findings из code review агентов (3, не из run-результатов)

### HIGH-1: `/demo/:templateId` находится внутри `<RequireAuth>`

- Файл: `frontend/src/App.tsx:27,36,49`
- Демо-плеер по дизайну — публичная marketing-поверхность (CTA "Try it yourself", "Real multi-agent runs, replayed", "Pre-recorded — no real LLM calls"). Сейчас неавторизованный посетитель улетает на `/login`.
- Заблокировано: 14 wave3-demo тестов не могут запуститься, plus реальные посетители landing-page не могут попробовать демо.
- Fix: вынести `<Route path="/demo/:templateId" element={<DemoPlayerPage />} />` за пределы `<RequireAuth>` (как и `/demos` gallery).

### MEDIUM-2: NewSessionPage Submit-кнопка не gated валидацией

- Файл: `frontend/src/pages/NewSessionPage.tsx:498`
- `disabled={submitting}` — disabled только при сабмите. Валидация выполняется, но кнопка не дизейблится по флагам `!isValid`. Юзер может кликнуть на пустой форме и получить toast/баннер.
- Fix: `disabled={submitting || !isFormValid}` где `isFormValid` = все валидаторы вернули true. Wave 1 P0 агент валидацию написал но не подключил.

### LOW-3: `PipelineBuilder` — dead code

- Файл: `frontend/src/components/PipelineBuilder.tsx`
- Никем не импортируется (`grep -rln "PipelineBuilder"` показывает только сам файл).
- Audit P2 finding из Улучшателей #2 предполагал что он используется на NewSession или Sessions — но в реальности он не подключён нигде.
- Fix: либо подключить на `/sessions/new` (раскрыть power-user конфиг), либо удалить файл (Non-Degradation: его никто не вызывает, удаление безопасно).

## Tests skipped — нужно для разблокировки

- 47 тестов требуют `E2E_AUTH_TOKEN` — JWT для авторизованных страниц.
- 10 fixme — нужны: `E2E_TEST_EMAIL` (для OTP-flow), способ драйва ConfirmDialog в loading-state, ApiKeySetupDialog reach, ErrorBoundary trigger.

## Severity classification

| Severity | Count |
|----------|-------|
| Critical | 0 |
| **High** | 1 (Demo behind RequireAuth) |
| **Medium** | 1 (NewSession submit-disable) |
| **Low** | 1 (PipelineBuilder dead) |

## Команда дальше: Team 3 (Fixers)

Запускается следующая фаза — фиксеры по этим 3 находкам. После них Team 2 re-runs все spec'и. Цикл закрывается когда 0/0/0/0.
