// КАО — Vitest config used by the regression tests added in
// frontend/src/__tests__/kao_vr25_to_27.test.tsx. This file is intentionally
// separate from vite.config.ts so the production build path is untouched.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    // КАО#VR-58 — also discover co-located lib unit tests (e.g.
    // src/lib/thinkingEfforts.test.ts) alongside the __tests__ suite.
    include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/lib/**/*.test.{ts,tsx}'],
    css: false,
    // КАО#R5-vitest-timeout — cold full-suite runs spend ~35s+ on module
    // imports before the first test executes; the default 5s testTimeout then
    // flakes the first heavy test (observed: kao_ux_audit UX-6). 15s keeps
    // genuine hangs failing fast while absorbing the cold-start tax.
    testTimeout: 15000,
  },
})
