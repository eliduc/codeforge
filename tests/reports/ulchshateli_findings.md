# Улучшатели — UX/UI/функциональный аудит CodeForge

5 параллельных аудиторов, 87 находок, склеены, дедуплицированы и
ранжированы. Шкала:

- **P0** — блокер (что-то реально сломано или скрыто опасно)
- **P1** — high impact (масштабная UX-просадка / частый путь / a11y)
- **P2** — polish (несогласованность, мелкие неясности)
- **P3** — nice-to-have

Усилие: **S** <1ч · **M** 1–4ч · **L** 1–3 дн · **XL** >3 дн

Заголовок в формате `[Pn·X] суть` — внутри тиров сортировка
"быстрые победы сверху" (max impact / min effort).

---

## P0 — блокеры (2)

- **[P0·M] WS-дисконнект тихий** — реконнект не показан в UI, юзер залипает на замороженном графе и не знает что фид мёртв (`SessionDetailPage.tsx:1235`, `services/api.ts:854) — добавить плашку "Reconnecting…" + индикатор.
- **[P0·S] NewSessionPage создаёт сессии без формы** — захардкожено `specification: '(not set)'`, Python, 5 итераций (`NewSessionPage.tsx:90`). Доступ к PipelineBuilder/шаблонам не виден. Деньги горят на дефолтный конфиг.

## P1 — high-impact (40)

### Кросс-резные крупные ставки (one fix = many wins)

- **[P1·M] Единая Button/Input примитив-библиотека** — сейчас каждый экран лепит свой `bg-cf-primary ...` с расходящимися radius/padding/colors (`SettingsPage.tsx:386`, `WebhooksSection.tsx:219`, `ConfirmDialog.tsx:115`, `ResultActionsExtras.tsx:328`). Введение `common/Button.tsx{variant, loading}` уберёт ~150 LOC и закроет десятки P2-нитов.
- **[P1·M] Единая модалка с focus-trap/Esc/a11y** — Headless UI Dialog в одних местах, голый `<div>` в других (`ResultActionsExtras.tsx:54`) — клавишник застревает за Share/Tests/Docs/Deploy.
- **[P1·M] Глобальный layer клавиатурных шорткатов / Cmd-K** — сейчас только Esc + случайные клавиши; навигация между Sessions/Dashboard/Settings и плеер демки полностью мышиные (`Layout.tsx:89`, `SessionDetailPage.tsx:1929`, `DemoPlayerPage.tsx:957`).
- **[P1·S] Light-тема ломается в модалках и тостах** — `ConfirmDialog.tsx:80`, `ApiKeySetupDialog.tsx:103`, `SpecificationsDialog.tsx:209`, `StyledToast.tsx:97` захардкожены `from-gray-800 to-gray-900` + `text-white`. В light-mode нечитаемо.
- **[P1·S] Native `confirm()` vs styled ConfirmDialog** — `WebhooksSection.tsx:178`, `SessionsPage.tsx:152` (template delete) против всего остального приложения. Один деструктив-pattern для всех.

### Sessions / Dashboard

- **[P1·M] Status-фильтр прячет другие фильтр-кнопки** — после сужения списка нельзя вернуться обратно (`SessionsPage.tsx:679`).
- **[P1·S] Search и filter работают только по последним 50 записям** — у юзеров с >50 сессий ложные "no results" (`SessionsPage.tsx:96,167`).
- **[P1·S] Нет сортировки сессий вообще** — порядок API-as-is, ни created/updated/cost/status (`SessionsPage.tsx:731`).
- **[P1·S] 4 экшен-кнопки на каждой карточке всегда видны** — Copy/Copy-Structure/Compare/Delete создают шум и две Copy путаются (`SessionsPage.tsx:808`) — overflow-меню или hover-reveal.
- **[P1·S] Apply-template диалог: error через toast вместо inline-validation** — required-поля без звёздочки, у textarea нет min-length (`SessionsPage.tsx:134`).
- **[P1·S] NewSessionPage error: только "Go to Settings", нет Try-again/Back** — юзер застрял (`NewSessionPage.tsx:130`).
- **[P1·S] Header action bar не responsive** — Import/Select/Export/Bulk/Templates/New в одну flex-строку, ломается на <1100px (`SessionsPage.tsx:416`).
- **[P1·S] Empty state "No sessions match filter" без кнопки Clear** — юзер сам ищет активную плашку (`SessionsPage.tsx:723`).

### Live Session

- **[P1·M] Pause/Cancel нет на `enhancing`** — только `running`/`paused`, enhancer-runaway не остановить (`SessionDetailPage.tsx:3907`).
- **[P1·M] Нет Retry-agent / Retry-from-failed-step UI** — только toast, recovery = полный Reset с потерей всей работы (`SessionDetailPage.tsx:2194`).
- **[P1·M] Auto-pan хайджечит viewport на каждом переходе** — нет "lock viewport" toggle, full-graph недоступен (`SessionDetailPage.tsx:2137`).
- **[P1·S] Streaming preview обрезан 200 символами, без scroll/copy/expand** — единственное окно "что агент делает прямо сейчас" нечитаемо (`AgentNode.tsx:452`).
- **[P1·S] Code-viewers — plain `<pre>` без syntax highlight / line numbers / search** — флагманская поверхность, читать невозможно (`DetailPanel.tsx:142`, `SessionDetailPage.tsx:4721`).
- **[P1·S] Intervention panel: нет истории, нет ACK что сообщение принято** — фаер-в-пустоту (`SessionDetailPage.tsx:4255`).
- **[P1·S] `?`-хоткей привязан, но ничего не делает** — нет в живом сессионе и одновременно нет шорткатов для pause/cancel/run/view code (`SessionDetailPage.tsx:1929`).
- **[P1·S] MetricsPanel issues-блок мёртв** — `criticalIssues`/`seriousIssues` никогда не апдейтятся, ключевой сигнал доверия показывает 0 (`SessionDetailPage.tsx:1156`, `MetricsPanel.tsx:143`).
- **[P1·S] Phase-indicator: raw lowercase `phase`** — `coding`/`summarizing`/`finalizing` только с CSS capitalize; нет "Testing iteration 3" (`SessionDetailPage.tsx:4118`).
- **[P1·S] Status badge: raw enum-строки** — `awaiting_enhancement_review` без humanization, а `getStatusLabel` уже написан и не используется (`MetricsPanel.tsx:71` vs `SessionDetailPage.tsx:3715`).

### Demo Player

- **[P1·M] Нет "what next" CTA после конца демо** — конфетти и пилюля, потом ничего; Try-it-yourself прячется (`DemoPlayerPage.tsx:743`).
- **[P1·M] Прогресс-бар не keyboard-доступен** — `onClick` only, нет `role="slider"`, `aria-valuenow`, focus, drag (`DemoPlayerPage.tsx:777`).
- **[P1·M] Нет keyboard на сам плеер** — Space/←/→/M не работают (`DemoPlayerPage.tsx:957`).
- **[P1·M] Seek-back ломает chapter-state** — после rewind через прогресс-бар может оказаться застрявшим на плашке N без anim (`useTimelinePlayer.ts:345`).
- **[P1·M] "Try it yourself" — мгновенный POST реальной сессии** — без confirm, без cost-оценки, без warning (`DemoPlayerPage.tsx:499`, `DemoGallery.tsx:61`).
- **[P1·M] Нет share/embed/copy-link CTA** — `/demo/:templateId` шарящийся URL никогда не выставлен (`DemoPlayerPage.tsx:541`).
- **[P1·M] Три дубль-компонента нарратива в бандле** — `ChapterBanner`/`ChapterPlaque`/`ChapterSidePanel` с расходящимися копипастами, рендерится только третий (`DemoPlayerPage.tsx:1054,1201,1324`).
- **[P1·M] Continue disabled mid-chapter без affordance** — выглядит как сломанная кнопка (`DemoPlayerPage.tsx:1178`).
- **[P1·L] Responsive ломается <900px** — 300px aside + InteractivePausePanel `min(34rem, 100vw-340px)` уходит в минус (`DemoPlayerPage.tsx:601`).
- **[P1·S] Speed presets кап 16×, без 0.5×** — DemosPage обещает "60× speed", но в плеере его нет (`DemoPlayerPage.tsx:61`, `DemosPage.tsx:17`).
- **[P1·S] "Pre-recorded" vs "real task" — два конфликтующих фрейма** — копирайт врёт (`DemosPage.tsx:17` vs `DemoPlayerPage.tsx:558`).

### Auth & Onboarding

- **[P1·S] Email-инпут без `autoComplete="email"`/`name`** — менеджеры паролей пропускают (`LoginPage.tsx:212`).
- **[P1·S] OTP-инпуты без `autoComplete="one-time-code"` + без `aria-label`** — iOS/Android SMS-autofill не работает, screen-reader читает 6 безымянных полей (`LoginPage.tsx:313`).
- **[P1·S] OTP auto-submit дублирует verify-логику** — расходящийся путь, future-bug (`LoginPage.tsx:117`).
- **[P1·S] Resend Code без rate-limit/cooldown** — двойной клик → двойная отправка (`LoginPage.tsx:346`).
- **[P1·S] "Request access" success — нет "use different email"** — юзер заперт (`LoginPage.tsx:265`).

### Settings / Cross-cutting

- **[P1·M] Settings reinvents API-key UI отдельно от ApiKeySetupDialog** — два onboarding-пути с расходящимися placeholder/focus/show-key, save не вызывает `testLLMProvider` (`SettingsPage.tsx:244` vs `ApiKeySetupDialog.tsx:119`).
- **[P1·M] Notifications-секции в Settings нет** — Webhooks/Toasts/email-service существуют, но toggle для email/browser/sound/verbosity отсутствует (`SettingsPage.tsx:170`).
- **[P1·S] Toaster z-stack / position-rule конфликт** — `position="top-right"` + hard-coded `top:80` в Layout, и каждый `notify.*` сам себя позиционирует (`StyledToast.tsx:168`); rapid notifications складываются.

## P2 — polish (31)

### Sessions / Dashboard

- [P2·S] SessionCompareModal без diff-view — два `<pre>` truncated 50k, нет line-wrap/syntax-highlight (`SessionCompareModal.tsx:232`).
- [P2·S] SessionCompareModal без empty/help state — Column B "No session selected" без guidance, swallows loading errors (`SessionCompareModal.tsx:51`).
- [P2·S] Copy/Copy-Structure/Delete внутри `<Link>` через `preventDefault` — некоторые браузеры всё равно навигируют (`SessionsPage.tsx:740`).
- [P2·S] Dashboard "Sessions by Status" — raw enum-строки без humanize и без link на отфильтрованный list (`DashboardPage.tsx:67`).
- [P2·S] PipelineBuilder remove-coder/tester без confirm/undo, без `aria-label` на `+/-` (`PipelineBuilder.tsx:223`).
- [P2·S] SharedSessionPage показывает raw `{session.status}` вместо `statusLabels` (`SharedSessionPage.tsx:158`).

### Live Session

- [P2·S] Edge artifact badges (📄/🔍/📋/✅) overlap, без tooltip направления/итерации (`ArtifactEdge.tsx:108`).
- [P2·S] 4 countdown-чипа (T:/R:/S:/A:) на 220px ноде — wrap без tooltip (`AgentNode.tsx:416`).
- [P2·S] Disabled enhancer: 40% opacity + grayscale — fails WCAG AA, нет in-place enable (`AgentNode.tsx:327`).
- [P2·S] "Click on an agent to view details" hint спрятан во время `running`/`enhancing` — именно когда новичку нужнее всего (`SessionDetailPage.tsx:4244`).
- [P2·M] Side-panel stack mutually exclusive без "back" — Run Code закрывает Detail/Code/Intervention без warning (`SessionDetailPage.tsx:3397`).
- [P2·S] Spec-node click target недискаверабельный — нет `cursor: help`, tooltip, hover-hint (`AgentNode.tsx:62`).
- [P2·S] Final Result fenced code в side-panel — `max-h-96` clip ~24 строк, нет expand-to-fullscreen (`SessionDetailPage.tsx:4721`).

### Demo Player

- [P2·S] FinalIframe sandbox `allow-scripts allow-same-origin` — комбинация дефитит sandbox per MDN (`DemoPlayerPage.tsx:866,994`).
- [P2·S] FinalIframe placeholder без "Skip to result" shortcut — юзер вручную скрабит (`DemoPlayerPage.tsx:854`).
- [P2·S] Legacy `StatusPlaque` рендерится только без chapters — но все шиппеные timelines с chapters, dead code на критической поверхности (`DemoPlayerPage.tsx:725,1670`).
- [P2·S] Pause/Continue race — нижняя ▶/⏸ обходит chapter-system, может оставить plaque chapter N с событиями N+1 (`useTimelinePlayer.ts:475`).

### Auth & Onboarding

- [P2·S] `location.state.from` без проверки на protocol-relative URL (`//evil.com`) — open-redirect surface (`LoginPage.tsx:27,93`).
- [P2·M] Tour auto-dismiss 12s + `markSeen` — отвернулся, потерял tour навсегда (`OnboardingTour.tsx:105`).
- [P2·S] Tour toast `role="dialog"` без focus-trap, без Esc, без aria-describedby (`OnboardingTour.tsx:116`).
- [P2·S] Welcome tour redirect `/demos` на Done без warning — returning users сюрприз (`OnboardingTour.tsx:302`).
- [P2·S] OTP-error wipe всех 6 цифр даже на сетевых ошибках — full retype после flaky connection (`LoginPage.tsx:97`).
- [P2·S] Tour стартует до DOM-таргетов — `data-tour="sessions-list"` отсутствует на пустом workspace, burns Welcome (`OnboardingTour.tsx:308`).

### Settings / Cross-cutting

- [P2·S] Settings loading state — центрированный spinner вместо skeleton rows; layout прыгает (`SettingsPage.tsx:238`).
- [P2·S] ConfirmDialog: два close-affordances с разным поведением — corner X обходит `safeClose`, dismiss mid-delete (`ConfirmDialog.tsx:84`).
- [P2·S] ApiKeySetupDialog non-dismissible (backdrop noop, no Esc), Skip — серая ссылочка — first-time юзер чувствует себя в ловушке (`ApiKeySetupDialog.tsx:79,147`).
- [P2·S] ErrorBoundary recovery = `location.reload()` — выбрасывает in-flight state и unsaved spec edits, нет "Copy error details" (`Layout.tsx:42`).
- [P2·S] Sidebar footer cramped, footer-метаданные пропадают в collapsed, нет Help/Docs/Shortcuts ссылок (`Layout.tsx:300,308`).
- [P2·S] Copy tone дрифтит между Title Case и sentence case в соседних кнопках — "Save Configuration" рядом с "Save changes" (`SettingsPage.tsx:227`, `WebhooksSection.tsx:450`).

## P3 — nice-to-have (14)

- [P3·S] Mini-map status palette не покрывает `executing`/`fixing`/`timeout` — fixing-coder показан как idle (`SessionDetailPage.tsx:4076`).
- [P3·S] Header action row не responsive — 6–8 кнопок шуруют title off-screen (`SessionDetailPage.tsx:3848`).
- [P3·S] Workflow-complete confetti pill — `<div>` без `aria-live`, screen-reader глух (`DemoPlayerPage.tsx:1472`).
- [P3·S] Spec-card collapse — global localStorage key, мутится между демками (`DemoPlayerPage.tsx:1007,1503`).
- [P3·S] Code input `h-13` — не дефолтная Tailwind size, на самом деле без height (`LoginPage.tsx:322`).
- [P3·S] "Not in allowed list" без timeline-ожидания / docs-ссылки (`LoginPage.tsx:258`).
- [P3·S] Dev-mode auto-login глушит onboarding-туры — `?tour=1` override (`OnboardingTour.tsx:204`).
- [P3·S] Logo не `aria-hidden`, читается перед form heading каждый раз (`LoginPage.tsx:187`).
- [P3·S] formatDate fixed `en-US`, игнорирует browser locale (`SessionsPage.tsx:396`).
- [P3·S] "Load More" — нет "Showing 50 of N", нет auto-scroll, нет jump-to-page (`SessionsPage.tsx:881`).
- [P3·S] Theme toggle в трёх местах с тремя визуальными treatment'ами — нужен `<ThemeToggle variant>` (`SettingsPage.tsx:188`, `Layout.tsx:244,310`).

---

## Сводная статистика

| Тир | Кол-во | Из них Quick wins (S) |
|-----|--------|------------------------|
| P0  | 2 | 1 |
| P1  | 40 | 20 |
| P2  | 31 | 27 |
| P3  | 11 | 11 |
| **Итого** | **84** | **59** |

(Из изначальных 87 находок 3 дедуплицированы как кросс-разные.)

## Рекомендация на первый спринт

Двигай по двум осям параллельно:

1. **2 P0 + 5 крупных кросс-сечений P1** (одна Button-примитив-библиотека и
   модалка с focus-trap закрывают десятки P2-нитов автоматически).
2. **Lift-and-shift все P1·S quick-wins** — это ~20 однострочников
   (autoComplete, aria-label, autocomplete-rate-limit, rate-limit), 
   которые без архитектурных изменений уберут половину UX-боли.

Спринт 1 (~3–5 дн): 2× P0 + Button/Modal/Toggle примитивы +
Cmd-K shell + 15 P1·S quick wins.
Спринт 2 (~1–2 нед): code highlight, retry-агент UI, intervention-история,
sort/filter сессий, demo keyboard player + share CTA, light-theme contract.
