// КАО#PE-A-npm — Flat config introduced during the dev-toolchain bump that
// migrated ESLint 8 -> 9 and @typescript-eslint 6 -> 8 (to clear the
// minimatch/flatted/brace-expansion advisories). The project previously had no
// committed ESLint config; the inline `eslint-disable` directives across src/
// document the intended rule set (react-hooks/exhaustive-deps,
// @typescript-eslint/no-explicit-any). Scope mirrors the prior lint script,
// which targeted only TS/TSX sources (`--ext ts,tsx`).
import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  // Build output, deps, coverage, vendored assets and all non-TS files
  // (config/scripts are .js/.mjs and were never in the lint scope).
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: { ...globals.browser },
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      // TypeScript itself reports undefined identifiers far more accurately
      // than the core rule, which misfires on TS syntax.
      'no-undef': 'off',
      // Unused-symbol enforcement is deliberately disabled to match the
      // project's tsconfig.json (noUnusedLocals: false, noUnusedParameters:
      // false). Keep eslint consistent with that choice rather than introduce
      // a stricter gate than the type-checker the project ships with.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      ...reactHooks.configs['recommended-legacy'].rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]
