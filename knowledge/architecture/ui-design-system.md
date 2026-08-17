---
type: architecture
title: CodeForge UI Design System
description: Portable specification of the CodeForge frontend look-and-feel — stack, theme tokens, layout shell, component primitives and UX conventions — so another project can reproduce the same interface.
tags: [ui, frontend, design-system, tailwind, react]
resource: frontend/src/
timestamp: 2026-07-11T00:00:00Z
---
# Stack
React 18 + TypeScript + Vite 7 + Tailwind 3 (`darkMode: 'class'`).
Key libs: **zustand** (state), **react-router-dom** v6, **@headlessui/react** (Dialog/Combobox),
**lucide-react** (icons), **react-hot-toast** (toasts), **clsx**, **@xyflow/react** (graph),
**highlight.js** (code), **driver.js** (onboarding tour).
Tests: vitest + @testing-library/react (jsdom), Playwright + @axe-core/playwright for e2e/a11y.

# Theme tokens (the core of the look)
Colors are **CSS variables** re-exported as Tailwind `cf-*` colors, so every component is
theme-agnostic. Defined in `frontend/src/index.css`, mapped in `frontend/tailwind.config.js`.

| Token | Light (`:root`) | Dark (`.dark`) |
|-------|-----------------|----------------|
| `--cf-bg` | `#f1f5f9` | `#0f1419` |
| `--cf-panel` | `#ffffff` | `#1a1f2e` |
| `--cf-border` | `#e2e8f0` | `#2d3748` |
| `--cf-text` | `#1e293b` | `#e2e8f0` |
| `--cf-text-muted` | `#475569` | `#94a3b8` |
| `--cf-input-bg` | `#f8fafc` | `#1a1f2e` |
| `--cf-hover` | `#f1f5f9` | `#2d3748` |
| `--cf-code-bg` | `#f1f5f9` | `#1a1f2e` |

Fixed brand colors (same in both themes): `primary #4f46e5`, `secondary #8b5cf6`,
`success #10b981`, `warning #f59e0b`, `error #ef4444`. Mono font: JetBrains Mono / Fira Code.

**Rule:** never hardcode `text-white` / `text-gray-400` on themed surfaces — always use
`text-cf-text` / `text-cf-text-muted`, otherwise the element vanishes in one theme
(a real bug fixed as КАО#R5).

# Layout shell
`frontend/src/components/layout/Layout.tsx` — `h-screen flex` (definite height so inner
panes scroll internally, never the page):
- **Sidebar** `w-64`, collapsible to `w-12` (state persisted in localStorage), 300ms
  transition. Logo → nav (Dashboard, Sessions, New Session, Demos, Settings) → footer with
  ThemeToggle + user dropdown (email, restart tour, Help submenu, logout, version).
- **Main** `flex-1 flex flex-col overflow-hidden`, wrapped in an **ErrorBoundary** offering
  "Try again / Copy error details / Reload".
- Mounted once at root: `<CommandPalette />` (⌘K/Ctrl-K), `<OnboardingTour />`, `<Toaster
  position="top-right" containerStyle={{top:80,right:16}} />`, plus a "Dismiss all" pill
  when ≥3 toasts are visible.

# Component primitives (`frontend/src/components/common/`)
`Button` (variants primary/secondary/ghost/danger; sizes sm/md; `leadingIcon`), `Modal`,
`ConfirmDialog`, `CodeBlock` (highlight.js), `StyledToast`, `ThemeToggle` (icon/centered
variants; light/dark/system), `CommandPalette` (Headless UI Combobox; commands + session
search), `ApiKeySetupDialog`, `SpecHelperPanel`.
Utility classes in `index.css` `@layer components`: `.btn-primary`, `.btn-secondary`,
`.btn-danger`, `.input-field`, `.card`, `.status-badge`, `.status-*`, `.severity-*`.

# UX conventions worth copying
- **Theme-aware always**: define the light palette on `:root`, override only tokens under
  `.dark`; give `body` an explicit token background.
- **Accessible names on icon-only controls**: `aria-label`, and for toggles
  `role="checkbox" aria-checked`; dialogs need a `Dialog.Title` (may be `sr-only`).
- **Keyframes live in `index.css`**, never in an inline `<style>` inside a button — that
  pollutes the button's `textContent` and re-injects on every render (КАО#R5).
- **Mobile**: control bars use `flex flex-wrap` with `order-*` + `w-full md:w-auto` so they
  wrap to two rows instead of overflowing.
- **Toasts** carry actions (e.g. "Load latest" / "Dismiss") for offers, not just messages.
- **Auth-loading guard**: while the auth store is `loading`, don't treat a user as anonymous
  (avoids bouncing a logged-in user to /login on a hard refresh).

# Files to read, in order
1. `frontend/tailwind.config.js` + `frontend/src/index.css` — tokens + base classes.
2. `frontend/src/components/layout/Layout.tsx` — the shell.
3. `frontend/src/components/common/` — primitives.
4. `frontend/src/pages/` — page composition patterns (Sessions, Settings, NewSession…).
5. `frontend/src/stores/themeStore.ts` — light/dark/system switching.

# See also
- [Deploy topology](deploy-topology.md)
- [Knowledge index](../index.md)
