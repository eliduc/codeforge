---
marp: true
theme: default
class: invert
paginate: true
size: 16:9
backgroundColor: "#0b1020"
color: "#e6eaf2"
style: |
  section {
    font-family: 'Inter', -apple-system, sans-serif;
    padding: 50px 80px;
  }
  h1 {
    color: #818cf8;
    font-weight: 800;
    font-size: 56px;
  }
  h2 {
    color: #a5b4fc;
    font-weight: 700;
    border-bottom: 2px solid #4f46e5;
    padding-bottom: 8px;
  }
  h3 { color: #c7d2fe; }
  strong { color: #fbbf24; }
  em { color: #34d399; font-style: normal; }
  blockquote {
    border-left: 4px solid #6366f1;
    padding-left: 16px;
    color: #cbd5e1;
    font-style: italic;
  }
  table { font-size: 22px; }
  th { background: #1e293b; color: #a5b4fc; }
  td, th { padding: 8px 12px; }
  code { color: #fbbf24; background: #1e293b; padding: 2px 6px; border-radius: 4px; }
  pre code { background: transparent; padding: 0; color: #e6eaf2; }
  .lead { font-size: 32px; color: #a5b4fc; font-weight: 600; }
  .small { font-size: 18px; color: #94a3b8; }
---

<!-- _class: invert -->

# CodeForge

## **Co-team**, не co-pilot

<br>

Команда AI-агентов, которая берёт спецификацию на естественном языке и
производит работающий код — *с встроенным аудитом, конкуренцией моделей
и автоматической сходимостью*.

<br>

<span class="small">gotcode.ai · v1.2</span>

<!--
SPEAKER NOTES:
- 30 секунд интро. Не углубляться в технику.
- Главное messaging: "co-team, не co-pilot". Если аудитория не уловила различие — остановись и переформулируй.
- Если демо-аудитория: открой gotcode.ai/demos в фоне до старта, на 4-й слайде покажешь живой граф.
- Если эфир C-level: подчеркни "audit trail" и "automated QA" — эти слова им резонируют.
-->

---

## Проблема

Современные AI-инструменты для разработки = **AI-помощник одному программисту**.

- Одна модель. Один проход. Ручной code review.
- Скрытое смещение: ты заперт в стиле одного LLM (Claude **или** GPT **или** Gemini).
- Нет встроенного контроля качества — нужно вручную просить «теперь поищи баги».
- Каждая попытка — *чёрный ящик*. Что попробовал? Где провалился? Почему именно так?

> Чем сложнее задача, тем хуже работает «один умный помощник».

<!--
SPEAKER NOTES:
- Цель слайда: вызвать «да, я с этим сталкивался».
- Спроси аудиторию: "Кто-нибудь делал code review кода от LLM? Сколько раз пропускали баг?"
- Не нападай на конкурентов поименно. Скажи "современные инструменты" обобщённо.
- Время: 45 сек.
-->

---

## Инсайт

В человеческой разработке мы знаем что:

- **Два инженера думают по-разному** → парное программирование, peer review.
- **Тестировщик ловит то, что не видит автор** → роль QA.
- **Архитектор оценивает иначе, чем кодер** → review на разных уровнях.

<br>

> *Почему AI-кодинг должен быть исключением?*

CodeForge приносит **командную динамику** в AI-генерацию кода.

<!--
SPEAKER NOTES:
- Этот слайд — мост. Не зачитывай буллеты, перескажи.
- "В реальной разработке мы знаем что одна голова — хорошо, а семь — лучше. И мы это формализуем: pair-prog, QA-роль, архитектурный review. AI-разработка пока работает в парадигме одной головы."
- Время: 30 сек.
-->

---

## Решение: Multi-Agent Orchestration

```
[Specification — plain English, 1–3 sentences]
                    │
                    ▼
[N Coders в параллель]   ← Claude Opus, GPT-5 Codex, Gemini
                    │
                    ▼  (артефакты кода)
[M Testers в параллель]  ← независимый аудит каждой версии
                    │
                    ▼  (списки issues)
[Summarizer] — ранжирует issues по важности
                    │
                    ▼  (итерация назад до convergence)
[Finalizer] — выбирает winner + объясняет выбор
                    │
                    ▼  (final_code)
[Enhancers в параллель] — Design / Functionality / Security
                    │
                    ▼
              ✅ Готовый артефакт
```

<!--
SPEAKER NOTES:
- Главный слайд: задержись на 60-90 сек.
- Покажи path спецификации сверху вниз. "Coders НЕ говорят друг с другом — они работают изолированно. Это намеренно: ансамбль разных мнений."
- "Testers тоже изолированы. И они проверяют ВСЕ версии coders, а не только одну."
- "Если на этой итерации остались критические issues — цикл повторяется. Если нет — Finalizer выбирает winner."
- На вопрос "а Enhancement обязательна?" — НЕТ. Останавливается на awaiting_enhancement, юзер сам решает.
-->

---

## Как это выглядит вживую

<div class="lead">

- **Real-time граф агентов** — видишь как каждый агент стримит код
- **Метрики:** токены, стоимость, итерации, время
- **WebSocket-события** — каждый шаг записан и replay'ится
- **Side-panels** — открой любого агента, посмотри что он написал

</div>

<br>

Не «сгенерируй код за 30 секунд». **Покажи как.**

<!--
SPEAKER NOTES:
- Идеальное место для LIVE DEMO.
- Открой stage.gotcode.ai/demos → Mandelbulb → нажми Play. Покажи граф 30 секунд.
- "Видите эти streaming-нити на нодах Coder 1 и Coder 2? Это два LLM генерируют код в параллель."
- "Через минуту они закончат, Testers начнут аудит. Вы увидите как обнаружится баг."
- Если демо ломается — переключись на pre-recorded `/demo/mandelbulb`. Это твоя страховка.
-->

---

## Wisdom of crowds

| Модель | Что приносит |
|--------|--------------|
| Claude Opus 4.5 | Тщательность, длинный контекст, объяснения |
| GPT-5 Codex | Скорость, краевые случаи, оптимизации |
| Gemini 2.5 Pro | Альтернативный архитектурный взгляд |

<br>

**В одной сессии** — все три модели независимо решают задачу.
Finalizer сравнивает результаты и выбирает лучший (с объяснением).

<br>

> Это не «mixture of experts» на уровне токенов. **Это competition на уровне решений.**

<!--
SPEAKER NOTES:
- Если аудитория техничная — поясни различие с MoE одной фразой:
  "MoE выбирает токены из роутера на уровне форварда. Здесь — целые архитектурные решения, скомпилированные разными моделями. Finalizer — это semantic-level mixer."
- Если бизнес-аудитория: "Это как нанять трёх разных подрядчиков и взять лучшее, только за минуты вместо месяцев."
- Время: 60 сек. Этот слайд — ключевой differentiator.
-->

---

## Built-in Quality Assurance

В большинстве AI-инструментов QA — это *ты*.

В CodeForge:

| Этап | Кто | Что делает |
|------|-----|------------|
| Generation | Coders | Параллельно пишут код от спеки |
| Audit | Testers | Независимо ищут баги в каждой версии |
| Prioritization | Summarizer | Ранжирует issues: critical → low |
| Iteration | Coders v2 | Учитывают summary, переписывают |
| Selection | Finalizer | Выбирает финальную версию + README |
| Polish | Enhancers | Design / Functionality / Security passes |

<br>

**До сходимости. Без супервизии.**

<!--
SPEAKER NOTES:
- Сильный момент для enterprise: "Когда нанимаете подрядчика — вы платите за код И за QA. У нас QA встроена."
- Если возражение "А вдруг агент пропустит баг?" — да, бывает. Но это происходит реже чем у single-model. И audit trail позволяет докрутить: посмотреть что Tester пропустил, поправить prompt.
- Не обещай perfect code — обещай "проверенный артефакт с честным аудитом".
-->

---

## Replay & Share

Каждая сессия — **first-class artifact**:

- 🎬 Pre-recorded demos с покадровой нарративной плашкой
- 🔗 Deep-links в конкретные главы (`?startAtChapter=N`)
- ⏯️ Speed control (0.5× — 60×), keyboard shortcuts, mobile-ready
- 📤 Share link — любая сессия публикуется как marketing demo

<br>

**Use case:** показал заказчику demo замысла → подписал contract → запустил session с реальной спекой.

Один путь от *идеи* через *показ* до *рабочего кода*.

<!--
SPEAKER NOTES:
- Сильный для marketing/sales: "Покажите заказчику живую сессию замысла, без mockup'ов — это убедительнее любого Figma-pitch'а."
- Demo-режим — это ПРОДУКТ внутри ПРОДУКТА. Можно показывать pre-recorded sessions, никого не нагружая реальной LLM-стоимостью.
- Use case: онбординг новых юзеров через "watch how it works first".
-->

---

## Реальные примеры из коробки

| Demo | Что внутри | Время |
|------|-----------|-------|
| 🌀 Mandelbulb 3D Attractor | WebGL2 ray-marching, 8 палитр, морфинг n=4→20 | ~3 мин |
| 🌌 Galaxy Collision (Barnes-Hut) | 5000 particles, gravitational N-body | ~3 мин |
| 🎮 Game of Life | Pattern gallery (Glider, Gosper), play controls | ~2 мин |
| 🏖️ Falling Sand Sandbox | 8 elements (sand, water, fire), 60fps | ~3 мин |
| 🧪 Gray-Scott Reaction-Diffusion | WebGL2 fragment shader, parameter sliders | ~3 мин |

<br>

Каждое — single-page HTML. Открывается прямо из браузера. Никаких зависимостей.

<!--
SPEAKER NOTES:
- Если время позволяет — открой ОДИН из них в браузере и нажми Play в demo player.
- Mandelbulb — самый эффектный визуально. Game of Life — самый понятный для нетехнической аудитории.
- "Каждое — это 3 минуты реальной LLM-генерации. То что вы видите — это не предрасчёт, это запись настоящего multi-agent run'а."
-->

---

## Когда CodeForge — **правильный выбор**

✅ Спецификация формулируется в 1–3 предложениях
✅ Результат — 1–2 файла, single page
✅ Алгоритмика / визуализация / симуляция
✅ Educational / dem'нстрационный материал
✅ A/B-сравнение моделей на одной задаче
✅ Нужен **audit trail** «кто что сделал»
✅ Качество > скорость (готовы тратить 3–10 мин)

<br>

**Sweet spot:** прототип за вечер с гарантией что прошёл tester-аудит.

<!--
SPEAKER NOTES:
- Не пытайся «продать всё». Этот слайд — фильтр.
- Если аудитория делает enterprise-monorepo edits — честно скажи "это не для вас, используйте Cursor".
- Лучшая фраза: "Если задача формулируется в одном предложении и результат — single-page, мы оптимальны. Если в трёх предложениях и multi-file — мы не оптимальны."
-->

---

## Когда НЕ CodeForge

❌ Edit'ы в большой существующей кодовой базе → **Claude Code / Cursor**
❌ Multi-file рефакторы → **Cursor Composer**
❌ Real-time pair-programming → **Cursor / Windsurf**
❌ Inline tab-completion → **Copilot**
❌ Bug fix в конкретной строке файла → **Claude Code** (overhead неоправдан)
❌ Architecture discussion → **ChatGPT / Claude (chat)**

<br>

CodeForge — не замена этим инструментам. **Это другой жанр.**

<!--
SPEAKER NOTES:
- Этот слайд снимает defensiveness. Аудитория ожидает "мы заменим всё" — мы говорим "нет".
- Это БОЛЬШОЙ trust-signal для technical buyer'ов.
- "Мы не пытаемся быть Cursor. Мы пытаемся быть тем, чем Cursor не является."
-->

---

## CodeForge vs. остальные

|  | CodeForge | Claude Code | Cursor | Codex | v0 / Bolt | Copilot |
|--|-----------|-------------|--------|-------|-----------|---------|
| Multi-agent | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-model | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Built-in QA | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ |
| Iteration loop | ✅ | manual | manual | manual | manual | — |
| Audit trail | ✅ | ⚠️ | ⚠️ | ✅ | ❌ | ❌ |
| Live viz | ✅ | ❌ | inline | ❌ | preview | ghost |
| Replay/Share | ✅ | ❌ | ❌ | PR | URL | ❌ |
| Greenfield | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ❌ |
| Existing codebase | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |

<!--
SPEAKER NOTES:
- Не озвучивай каждую клетку. Скажи: "Мы лидируем в строках где multi-agent / multi-model / built-in QA / live viz / replay. Мы НЕ для existing codebase — там у конкурентов преимущество."
- Если спросят про конкретный конкурент — будь конкретен и уважителен. Никогда не говори "X плохой". Говори "X решает другую задачу".
- Время: 90 сек, важный слайд.
-->

---

## Hybrid workflows

CodeForge **дополняет**, а не заменяет.

| Шаг 1 | Шаг 2 |
|-------|-------|
| **CodeForge** генерирует standalone particle-эффект | **Cursor** интегрирует в React-компонент landing-page |
| **CodeForge** пишет force-directed graph algorithm с тестами | **Claude Code** встраивает в `<GraphView />` дашборда |
| **CodeForge** делает sandbox HTML с iframe-securing | **Claude Code** оборачивает как route в production app |
| **CodeForge** строит SVG-лого с morphing-анимацией | **Claude Code** упаковывает как `<Logo />` компонент |

<br>

**Принцип:** CodeForge для greenfield-куска, IDE-tool для интеграции.

<!--
SPEAKER NOTES:
- Этот слайд — для аудитории "у нас уже есть Cursor". Он снимает страх "купить и не использовать".
- "Мы не просим вас отказаться от Cursor. Мы просим использовать нас там, где Cursor тратит часы — а мы решаем за минуты."
- Hybrid — самый частый реальный сценарий внедрения в команды.
-->

---

## Стоимость единицы качества

| Tool | $ за задачу | Что получаешь |
|------|-------------|---------------|
| **CodeForge** | $0.30 – $2.00 | Артефакт + audit trail + Tester-аудит |
| Claude Code | $0.05 – $0.50 | Diff, требует ревью человеком |
| OpenAI Codex | $0.10 – $1.00 | PR, требует ревью человеком |
| Cursor | $0.20 – $1.50 | Inline-помощь, требует постоянного supervision |
| v0 / Bolt | $0.05 – $0.30 | UI-page, не для production |
| Copilot | flat subscription | Tab-completion |

<br>

CodeForge дороже **на задачу** — но почти **не требует супервизии**.
Удельная стоимость качества часто **ниже** в sweet-spot задачах.

<!--
SPEAKER NOTES:
- Самое острое возражение: "Это дорого". Будь готов к нему.
- Контр-аргумент: "Час старшего инженера = $80-150. Если CodeForge экономит даже 30 минут supervision на task — мы окупаемся."
- ROI расчёт: $1.50 на CodeForge + 5 минут review = $1.50 + $12 = $13.50.
  Cursor $0.50 + 30 минут review = $0.50 + $75 = $75.50.
  Multi-agent окупается за счёт меньшей supervision'ной нагрузки.
- Если аудитория hobbyist — этот слайд можно пропустить за 10 сек.
-->

---

## Технологии

<div class="small">

**Frontend:** React 19 + Vite + TypeScript + Tailwind + React Flow (live graph)
**Backend:** FastAPI + SQLAlchemy 2 + Alembic + Postgres + Celery + Redis
**Streaming:** WebSocket с reconnect/backoff
**Sandbox:** Headless Chromium (Playwright) для JS, Docker для Python
**LLM-providers:** Anthropic, OpenAI, Google, OpenRouter

</div>

<!--
SPEAKER NOTES:
- Slide для technical buyer'ов и DevOps. Skip если аудитория business.
- Подчеркни: "Backend не lock-in на одного провайдера. Если завтра появится новая модель — мы её добавляем за день."
- Open-source roadmap (Q4): self-host версия с локальными LLM.
-->

---

## Что внутри audit trail

Полная запись WebSocket-событий каждой сессии:

```
t=0.0   workflow_started
t=14.0  iteration 1 → phase: coding
t=14.2  agent_started: coder_0 (claude-opus-4.5)
t=15.0  agent_streaming: coder_0 → <!DOCTYPE html>...
...
t=68.4  agent_completed: coder_0 — 1850 tokens, $0.12, 0 issues
t=68.9  agent_started: tester_0 (claude-sonnet-4.5)
...
t=158.0 finalizer_completed → chose coder_1 (reasoning: "Cleaner sphere-tracing loop, ...")
t=160.0 workflow_completed
```

<br>

Идеально для **post-mortem**, **обучения**, **billing-аудита**, **демо**.

<!--
SPEAKER NOTES:
- Compliance-аудитория: "Каждый LLM-call залогирован. Каждый промпт сохранён. Каждый артефакт хеширован."
- "Если завтра вас спросят 'почему этот код производит X' — у вас есть полная trail отвечающих агентов."
- Hot topic для finance/health/legal: provenance важна.
-->

---

## Decision-tree за 10 секунд

```
Задача greenfield, single-page, спека в 1-3 предложениях?
│
├── ДА → CodeForge ✅
│       (особенно если важна QA из коробки)
│
└── НЕТ:
    ├── Уже есть codebase, точечные правки?
    │   ├── В IDE → Cursor / Windsurf
    │   ├── В CLI / много файлов → Claude Code
    │   └── PR-уровень → Codex
    │
    ├── Landing / marketing page?
    │   └── v0 / Bolt
    │
    ├── Inline completion?
    │   └── Copilot
    │
    └── Discussion / architecture?
        └── ChatGPT / Claude (chat)
```

<!--
SPEAKER NOTES:
- Дай аудитории cheat-sheet "куда сходить когда". Это полезный takeaway.
- Подчеркни: "Этот tree — наш честный фреймворк. Мы не на каждой ветке."
- Скриншот этого слайда — отличный share-asset для Twitter/LinkedIn.
-->

---

## Дорожная карта

<div class="small">

**Q3 2025**
- ✅ Multi-coder ensemble, Testers, Summarizer, Finalizer
- ✅ Enhancement phase (Design / Functionality / Security)
- ✅ Replay & deep-link demos

**Q4 2025**
- ✅ WS reconnect UI, retry-agent affordance
- ✅ Multi-file output поддержка
- ✅ Sessions API + CLI client

**Q1 2026**
- 🔄 Git integration: PR-based output, repo-aware tester
- 🔄 Domain-specific agent personalities (security-first, perf-first)
- 🔄 Custom agent roles via config

**H2 2026**
- ⏳ On-prem edition
- ⏳ Fine-tunable role-specific models

</div>

<!--
SPEAKER NOTES:
- Roadmap — это для serious buyer'ов. Покажи коммитмент.
- Если спросят про Q3 2026+ — скажи "обсудим в личной встрече, есть несколько partnership-направлений".
- Custom agent roles — фича для enterprise. Пример: "финтех-клиент имеет роль Compliance-agent, который проверяет код на regex'ы паттернов credit card / SSN."
-->

---

## Попробуй сейчас

<div class="lead">

🌐 **stage.gotcode.ai/demos** — 5 готовых demo, играй прямо в браузере

🚀 **gotcode.ai** — создай свою первую сессию

📚 **gotcode.ai/docs** — спецификации, API, примеры

</div>

<br>

<br>

> *Best way to predict the future is to invent it.*
> — Alan Kay

<!--
SPEAKER NOTES:
- Этот слайд — CTA. Не растекайся.
- Один из трёх: либо "посмотри demo сейчас", либо "запиши свою первую сессию", либо "приходи на 1-on-1 demo".
- Прямой призыв: "Открой gotcode.ai/demos прямо сейчас на телефоне — 30 секунд, вы увидите Mandelbulb."
-->

---

<!-- _class: invert -->

# Спасибо

**CodeForge — co-team, not co-pilot.**

<br>

<span class="small">Вопросы, демо-сессия 1-on-1, partnership inquiries: gotcode.ai/contact</span>
