# CodeForge — Project Rules

## Non-Degradation Rule

**CRITICAL**: No change to the codebase should silently remove, break, or degrade existing functionality. This applies to ALL modifications — bug fixes, new features, refactors, and dependency updates alike.

Before committing any change:
1. Verify that all existing features still work as before (UI elements, timers, animations, API endpoints, WebSocket events, etc.)
2. If a change unavoidably affects existing behavior, explicitly notify the user and get approval BEFORE proceeding.
3. If code is being restructured, ensure the replacement preserves all capabilities of the original.

Examples of violations: removing countdown timers while adding timeout logic, breaking edge animations while restructuring the graph, dropping API fields while refactoring schemas.

## Глоссарий

### «Запустить агентов» / КАО (команда агентов-отладчиков)

Когда пользователь говорит «запустить агентов» (или «КАО», «команда агентов»),
это означает следующий цикл из трёх подкоманд:

1. **Писатели тестов** — состоят из ТРЁХ параллельно работающих подкоманд.
   Каждая итерация КАО → **full coverage всего приложения** (не только
   изменившийся код): новые тесты дополняют существующий набор, никогда
   не заменяют.

   1.1. **UI/UX писатели** — тестируют интерфейс, расположение элементов,
        отсутствие overlapping, соответствие мировым best-practices дизайна.
        Стек:
        - **Playwright E2E** (`e2e/tests/`) — user-flow в реальном Chromium:
          навигация, клики, текст в DOM
        - **Visual regression** — попиксельные screenshot-diff'ы (ловит
          layout drift, накладывающиеся элементы)
        - **Lighthouse / Axe** — accessibility (WCAG), performance, SEO
        - **Vitest + React Testing Library** — компонент-уровень

   1.2. **Functionality писатели** — покрывают всю функциональность
        приложения, включая мельчайшие элементы. Это backend pytest +
        sandbox node tests + frontend vitest на бизнес-логику. На каждой
        итерации КАО — полный обход, не только то что изменилось.

   1.3. **Security писатели** — обязательное покрытие 4-х классов:
        - **Auth/Authz** — JWT-валидация, ownership-чеки на каждом
          endpoint, отказ в доступе к чужим session/code_version
        - **Input validation / injection** — фаззинг полей; попытки SQL,
          XSS, path traversal в строковых параметрах
        - **Dependency vulnerabilities** — `npm audit` + `pip-audit`,
          сверка с известными CVE
        - **Secrets / config leaks** — проверка что `.env`, secret keys,
          tokens не попадают в логи, API-ответы, frontend-bundle

   Все три подкоманды стартуют **одновременно** (параллельно), их тесты
   потом сливаются в общий пул и передаются тестерам.

2. **Тестеры** — гоняют весь объединённый пул, классифицируют находки
   (critical / serious / minor / suggestion), передают фиксерам.

3. **Фиксеры** — правят найденное, **управление снова уходит тестерам**
   (не верим self-report фиксера — независимая верификация после каждого
   раунда).

Цикл «Тестеры → Фиксеры → Тестеры» повторяется до тех пор, пока тестеры
не вернут **0/0/0/0** (нуль critical, serious, minor И suggestion) в зоне
ответственности раунда КАО. Pre-existing проблемы проекта (не связанные с
текущим раундом) — фиксируются отдельным task'ом, не блокируют завершение.

Каждое выявленное и исправленное в ходе цикла исправление маркируется
тегом `КАО#<idшага>` в коде и в сообщениях коммитов — чтобы можно было
поднять историю «что нашёл и пофиксил КАО».
