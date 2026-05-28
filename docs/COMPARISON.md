# CodeForge vs. стандартные AI-инструменты разработки

Сравнение по 14 размерностям. CodeForge — multi-agent orchestration система,
которая компилирует естественно-языковую спецификацию в работающий код
параллельными coder-моделями с автоматическим QA-циклом до convergence.
Большинство «стандартных» инструментов в этой нише — single-agent
помощники разработчику.

---

## Сводная таблица

| Размерность | **CodeForge** | Claude Code (CLI) | OpenAI Codex (cloud agent) | Cursor / Windsurf | v0 / Bolt / Replit Agent | GitHub Copilot |
|-------------|---------------|-------------------|---------------------------|-------------------|--------------------------|----------------|
| **Архитектура** | Multi-agent оркестрация: 2-4 Coders в параллель → 2 Testers → Summarizer → Finalizer → 4 Enhancers | Single agent, REPL | Single agent, async cloud | Single agent + tab-completion модель | Single agent | Single completion model |
| **Режим работы** | Fire-and-forget с live-visualization | Interactive (synchronous) | Async (PR-based) | Interactive (IDE) | Interactive (preview) | Tab inline + chat |
| **Цель** | Greenfield от спецификации | Edit + refactor существующего кода | Edit + PR-driven | Edit + write в IDE | Greenfield single-page app | Inline completion |
| **Wisdom of crowds** | ✅ N coders компетируют, Finalizer выбирает лучшее + объясняет почему | ❌ один поток | ❌ | ❌ | ❌ | ❌ |
| **Built-in QA** | ✅ Testers аудитят код параллельно, Summarizer ранжирует issues, итерация повторяется | ⚠️ через `Task` агентов, ручной запрос | ⚠️ ручной запрос | ⚠️ через chat-prompt | ❌ | ❌ |
| **Iteration loop** | ✅ Coders → Testers → Summary → Coders... до convergence (`max_iter` настраивается) | Manual: пользователь говорит "fix this" | Manual: comments на PR | Manual: повторные prompts | Manual: edit prompt | — |
| **Enhancement layer** | ✅ Design / Functionality / Security агенты делают второй проход после Finalizer | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Audit trail** | ✅ Полный WS-event log: какой агент что писал, токены, стоимость, время | ⚠️ через `/transcript` | ✅ PR-diff + commit log | ⚠️ через chat history | ❌ | ❌ |
| **Replay / Share** | ✅ Pre-recorded demos с deep-links (`/demo/<id>?startAtChapter=N`) | ❌ | PR url | ❌ | URL deploy | ❌ |
| **Live visualization** | ✅ Real-time граф агентов (React Flow), streaming preview, метрики | ❌ | progress polling | inline diffs | preview iframe | inline ghost |
| **Sandbox исполнение** | ✅ Headless Chromium для JS, Docker для Python — авто-валидация результата | ✅ Bash | ✅ контейнер | ❌ (запуск в IDE) | ✅ iframe preview | ❌ |
| **IDE интеграция** | ❌ (web UI standalone) | ❌ (CLI) | ❌ | ✅ VS Code / Cursor IDE | ❌ | ✅ VS Code/JetBrains |
| **Multi-model по умолчанию** | ✅ Mix Anthropic + OpenAI + Google в одной сессии | ⚠️ Anthropic only | ⚠️ OpenAI only | ⚠️ выбор одной | ⚠️ одна | ⚠️ одна |
| **Стоимость на задачу** | Высокая (N×coder + M×tester + summarizer + finalizer + опц. enhancers) | Низкая (один поток) | Средняя | Низкая (только то что пользователь дёргает) | Средняя | Минимальная |
| **Сложность задачи** | Small-to-medium scope (1-3 файла, single page) | Любая (большая кодовая база ОК) | Medium (PR-scope) | Любая | Web app from scratch | Inline-level |

---

## Когда стоит использовать CodeForge

### Идеально подходит

- **Алгоритмическая визуализация / симуляции** — Mandelbulb, particles, falling
  sand, fluid sim, fractal explorers, retro shaders. Multi-coder ensemble даёт
  разные подходы → Finalizer выбирает лучший.
- **Single-page интерактивные приложения** — игры (snake, life), генеративное
  искусство, образовательные демо.
- **Когда важна качественная гарантия "из коробки"** — Testers аудитят код,
  Summarizer ранжирует issues, цикл повторяется. Не нужно вручную просить
  "теперь проверь баги".
- **Демонстрация / обучение** — каждая сессия может быть replay'нута как
  pre-recorded demo с покадровой нарративной плашкой. Хорошо для пояснения
  "как multi-agent система работает".
- **A/B-сравнение моделей** — N разных моделей решают одну задачу параллельно,
  видно как они отличаются по подходу и качеству.
- **Аудит — нужна история "кто что сделал"** — полный WebSocket лог + replay
  покажет любую сессию post-mortem.

### Не подходит

- **Редактирование большой существующей кодовой базы** → Claude Code / Cursor.
  CodeForge сейчас greenfield-ориентирован.
- **Многофайловые рефакторы** → Cursor Composer / Claude Code.
- **Pair-programming real-time** → Cursor / Windsurf inline.
- **Inline-комплеция в IDE** → Copilot / Cursor Tab.
- **Production-grade прод-код** где нужен code-review человеком — Codex async +
  GitHub PR-workflow.
- **Узкие edit'ы / переименования / regex-замены** — overhead запуска
  multi-agent неоправдан.

### Sweet spot

Задачи где:

1. Спецификация формулируется на естественном языке за 1-3 предложения.
2. Результат — один-два файла (HTML+JS, Python-скрипт, single-page app).
3. **Качество > скорость** (готов потратить 3-10 минут на multi-agent цикл).
4. Хочется увидеть КАК агенты работают (демо/обучение).
5. Полезен мульти-модельный консенсус (несколько LLM на одну задачу).

---

## Архитектурное отличие в одной фразе

> Standard tools — *AI помогает программисту писать код в IDE*.
>
> CodeForge — *команда из N LLM-агентов с разными ролями параллельно
> производит и аудитит код по плоской спецификации, до convergence,
> без участия пользователя в цикле*.

Это другой жанр: не co-pilot, а **co-team**.

---

## Подробнее: pipeline CodeForge

```
[Specification (plain English)]
            │
            ▼
[N Coders in parallel]  (claude-opus-4.5, gpt-5.1-codex, ...)
            │
            ▼  (artifacts)
[M Testers in parallel]  (claude-sonnet-4.5, gemini-2.5-pro, ...)
            │
            ▼  (audits)
[Summarizer]  → ранжированный список issues
            │
            ▼ (если итерация < max_iter, цикл назад к Coders)
            │
            ▼ (convergence)
[Finalizer]  → выбирает winner из всех Coder-версий + объяснение
            │
            ▼  (final_code)
   [✅ awaiting_enhancement — опционально]
            │
            ▼
[Enhancers in parallel]: Design / Functionality / Security
            │
            ▼  (предложения для apply/reject)
   [Enhancement Review] → пользователь принимает/отвергает каждое
            │
            ▼
       [✅ completed]
```

Каждый шаг — это отдельный LLM-вызов с собственной системной промптой и
ролью. Все события стримятся через WebSocket, видны в графе на live-странице.

---

## Cheat-sheet: реальные use-case'ы

Каждая строка — **реальная спецификация в стиле CodeForge**, инструмент,
комментарий "почему" и ожидаемый артефакт.

### A. Алгоритмическая визуализация / генеративное искусство

| Спецификация | Инструмент | Почему | Артефакт |
|--------------|------------|--------|----------|
| "WebGL2 ray-marched Mandelbulb с морфингом power n=4→20, 8 палитр, restart-control" | **CodeForge** ✅ | Один HTML-файл, multi-coder ensemble даёт разные подходы к sphere-tracing, testers ловят NaN/edge-cases | `index.html` ~22KB с shader-loop |
| "Lorenz attractor в 3D + slider для параметров σ/ρ/β" | **CodeForge** ✅ | Single-page, нужны разные подходы к ODE-интеграции (RK4 vs Euler) | `index.html` + Three.js или vanilla WebGL |
| "Spirograph generator с N gears, color cycling, save-as-PNG" | **CodeForge** ✅ | Чистая алгоритмика, нужен Tester что не сломалось при gear=1 | `index.html` ~10KB |
| "Falling-sand sandbox: 8 elements (sand, water, fire, oil...), 60fps на 200×200 grid" | **CodeForge** ✅ | Pixel-perfect логика interactions, Testers критичны | `index.html` с cellular automata |
| "Animated 2D fluid simulation, SPH method, mouse-driven" | **CodeForge** ✅ | Запутанная физика, multi-coder = разные численные методы | `index.html` ~15KB |
| "Conway's Game of Life: pattern gallery (Glider, Gosper Gun, Penrose), step/play/speed controls" | **CodeForge** ✅ | Простая логика + UI; demo для обучения | `index.html` |
| "Galaxy collision Barnes-Hut N-body, 5000 particles, GPU-accelerated" | **CodeForge** ✅ | Алгоритмически сложно, parallel-coder подход выигрывает | `index.html` + WebGPU |

### B. Образовательные и интерактивные виджеты

| Спецификация | Инструмент | Почему | Артефакт |
|--------------|------------|--------|----------|
| "Алгоритм Дейкстры на интерактивном графе: step-by-step, цветовая подсветка" | **CodeForge** ✅ | Дидактика, нужен чистый код + visual; testers ловят корректность алгоритма | `index.html` |
| "Sorting algorithm zoo: bubble/quick/merge/radix, race mode" | **CodeForge** ✅ | Каждый алгоритм отдельно тестируется, summarizer пушит за правильность | `index.html` |
| "FFT-визуализатор: input audio → real-time spectrum + spectrogram" | **CodeForge** ✅ | Web Audio API + canvas, нужны разные подходы к FFT | `index.html` |
| "Neural net в браузере: рисуй цифру → MNIST-классификатор показывает confidence" | **CodeForge** ✅ или v0 | Multi-coder подход к импорту pretrained-весов | `index.html` + `.json` weights |
| "Demo: как multi-agent system работает (для конференции)" | **CodeForge** demo player ✅ | Replay сессии = идеальный rehearsable показ | `/demo/<id>` deep-link |
| "Pendulum lab: double-pendulum + chaos, traces, mass/length sliders" | **CodeForge** ✅ | ODE-интеграция, легко проверить корректность | `index.html` |

### C. Casual games (single page)

| Спецификация | Инструмент | Почему | Артефакт |
|--------------|------------|--------|----------|
| "Snake с arrow keys, growing tail, score, restart" | **CodeForge** ✅ | Кошка-canon: testers проверят wall-collision, self-collision | `index.html` ~5KB |
| "Tetris на canvas, 7 фигур, line-clear, soft drop" | **CodeForge** ✅ | Алгоритмика + game-loop, multi-coder = разные коллизионные подходы | `index.html` |
| "Breakout с paddle, brick-grid 8×5, power-ups" | **CodeForge** ✅ | Game-loop + физика | `index.html` |
| "Asteroids: WASD movement, shoot, wrap-around screen" | **CodeForge** ✅ | Vector-arithmetic + collision; classic | `index.html` |
| "2048 grid game с keyboard + swipe support" | **CodeForge** ✅ | Чистая логика merge — testers критичны для корректности | `index.html` |

### D. Прототипы / UI-демо

| Спецификация | Инструмент | Почему | Артефакт |
|--------------|------------|--------|----------|
| "Landing page для SaaS X: hero, features grid, pricing, footer" | **v0 / Bolt** ✅ | Стилистический output, marketing-копирайтинг, design-first | React/Next page |
| "Dashboard mockup: KPI cards + chart + recent activity" | **v0 / Bolt** ✅ | Дизайн-ориентированно, не нужен ML-цикл аудитов | Static React |
| "Trello-clone в одном файле (drag-drop, localStorage)" | **CodeForge** ✅ | Single-page, нужен Tester для DnD корректности | `index.html` |
| "Markdown preview pane: split-screen edit + render" | **CodeForge** ✅ или Bolt | Простая single-page фича | `index.html` |

### E. Data utility / расчёты

| Спецификация | Инструмент | Почему | Артефакт |
|--------------|------------|--------|----------|
| "CSV-парсер браузерный: drop file → table preview + filter" | **CodeForge** ✅ | Single-page, edge-cases (escaped quotes, multiline) ловят Testers | `index.html` |
| "Color-picker с HSL/RGB/HEX/LAB, palette extractor from image" | **CodeForge** ✅ | Алгоритмика + canvas | `index.html` |
| "Audio-trimmer: drag start/end на waveform, export MP3" | **CodeForge** ✅ | Web Audio + Canvas, нужны Testers для buffer-обработки | `index.html` |
| "Регексп-tester с подсветкой матчей, common patterns gallery" | **CodeForge** ✅ или Cursor | Single-page, простая фича | `index.html` |

### F. Реальная инженерная работа (CodeForge НЕ подходит)

| Задача | Инструмент | Почему НЕ CodeForge |
|--------|------------|---------------------|
| "Поправь bug в `frontend/src/hooks/usePoll.ts:42` — `clearInterval` не вызывается при unmount" | **Claude Code / Cursor** | Существующая codebase, multi-file context |
| "Добавь dark-mode по всему приложению через CSS variables" | **Cursor Composer / Claude Code** | Multi-file refactor, нужно понимать существующие компоненты |
| "Напиши Playwright e2e на login flow" | **Claude Code / Cursor** | Контекст существующих fixtures + проектная конвенция |
| "Подытожь PR #1234 и предложи фиксы" | **OpenAI Codex / Claude Code** | PR-attached работа |
| "Расширь схему БД: добавь колонку `user.preferences` + миграция alembic" | **Claude Code** | Знание существующих миграций + ORM-моделей |
| "Help fix flaky test in `tests/test_session_workflow.py`" | **Claude Code** | Большая codebase, нужна стек-трейс интуиция |
| "Сделай dependency upgrade: bump react 18→19, fix breaking changes" | **Claude Code / Cursor** | Меньше про "написать с нуля", больше про точечные правки |
| "Перепиши legacy jQuery-плагин на React" | **Cursor Composer** | Multi-file refactor существующего кода |
| "Auto-complete функции по docstring'у" | **Copilot** | Inline-завершение |
| "Pair-программирование при написании React-компонента" | **Cursor / Windsurf** | Real-time interactivity |
| "Provision Terraform для AWS RDS + VPC" | **Cursor / Claude Code** | Infrastructure-as-code, нужно знание модулей |

### G. Hybrid / "сначала CodeForge → потом Claude Code"

Бывают задачи где **CodeForge стартует прототип**, потом **Claude Code / Cursor интегрирует** в большую кодовую базу.

| Сценарий | Pipeline |
|----------|----------|
| "Хочу particle-эффект на landing-page моего SaaS" | 1) CodeForge генерирует standalone `particles.html`. 2) Cursor портирует в React-компонент, интегрирует в layout. |
| "Нужен векторный logo с анимацией морфинга" | 1) CodeForge генерирует SVG + JS animation. 2) Claude Code оборачивает в `<Logo />` компонент. |
| "Алгоритм auto-layout графа (force-directed) для нашего dashboard" | 1) CodeForge пишет чистый алгоритм + тесты. 2) Cursor интегрирует в существующий `<GraphView />`. |
| "Хочу in-app sandbox где юзер пишет JS и видит результат" | 1) CodeForge делает standalone `sandbox.html` с iframe sandboxing. 2) Claude Code встраивает как route в app. |

### H. Не-кодовые задачи (для контекста)

| Задача | Инструмент |
|--------|------------|
| "Объясни мне как работает Y-Combinator в λ-calculus" | ChatGPT / Claude / Gemini |
| "Перепиши этот email с менее агрессивным тоном" | ChatGPT / Claude |
| "Generate 10 marketing taglines for X" | ChatGPT / Claude |
| "Помоги с архитектурным решением: REST vs GraphQL для нашего use-case" | ChatGPT / Claude (как раз discussion-tool) |

---

## Сигналы «нужен CodeForge»

Услышали один из этих фрейзов от вас или заказчика — это маркер:

- **"Сделай standalone HTML с..."** → CodeForge
- **"Я хочу демо как работает..."** → CodeForge (с replay)
- **"Покажи как разные модели решают..."** → CodeForge (multi-coder)
- **"Нужен прототип за вечер, single page"** → CodeForge
- **"Какие баги в этом куске кода?"** → CodeForge Testers (или Claude Code если уже в кодовой базе)
- **"Сравни 3 алгоритма для X"** → CodeForge с 3 разными моделями

## Сигналы «не CodeForge»

- **"В нашей кодовой базе..."** → Cursor / Claude Code
- **"В этом PR..."** → Codex / Claude Code
- **"Допиши tab-completion / signature..."** → Copilot
- **"Real-time pair-prog..."** → Cursor / Windsurf
- **"Конкретный bug fix в файле X строка Y"** → Cursor / Claude Code (overhead CodeForge неоправдан)

---

## Стоимость грубо

| Tool | Типичная задача | Цена за задачу |
|------|-----------------|----------------|
| **CodeForge** (4 coders × 3 testers × enhancement = ~10 LLM calls @ Claude/GPT-5) | Single-page demo с QA | **$0.30 – $2.00** |
| Claude Code | Bug fix + small refactor | $0.05 – $0.50 |
| OpenAI Codex (cloud) | PR-level patch | $0.10 – $1.00 |
| Cursor (включая Tab) | Pair-programming session 1ч | $0.20 – $1.50 |
| v0 / Bolt | Landing page | $0.05 – $0.30 |
| Copilot | Inline completions сутки | flat subscription |

CodeForge дороже на задачу — но даёт **проверенный artifact**, audit trail и
**не требует супервизии**. Удельная стоимость единицы качества часто ниже,
если задача попадает в sweet spot.

---

## Краткий decision-tree

```
Задача greenfield, single-page, спецификация в 1-3 предложениях?
├── ДА → CodeForge (особенно если нужна QA из коробки)
└── НЕТ:
    ├── Уже есть кодовая база, нужны точечные правки?
    │   ├── В IDE → Cursor / Windsurf
    │   ├── В CLI / много файлов → Claude Code
    │   └── PR-уровень → Codex
    ├── Landing / marketing page?
    │   └── v0 / Bolt
    ├── Inline-комплеция?
    │   └── Copilot
    └── Discussion / architecture?
        └── ChatGPT / Claude / Gemini
```

