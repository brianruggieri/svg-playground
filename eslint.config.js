/*
 * ESLint flat config (CommonJS) — split top-level entries, no nested 'overrides'
 * Uses the flat configuration format but authored as CommonJS so node execution
 * and toolchains that expect CommonJS can require it easily.
 *
 * Notes:
 * - Removed `project` parser option (no tsconfig at the repo root).
 * - Each glob-based configuration is expressed as a top-level array entry.
 * - This avoids nested `overrides` which the flat format does not accept.
 */

const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettierPlugin = require('eslint-plugin-prettier');

module.exports = [
  // Global ignore patterns
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '*.min.js',
    ],
  },

  // TypeScript files (ts, tsx) — TypeScript-aware rules, no `project`/type-aware rules here
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // Intentionally omitted `project` to avoid requiring a tsconfig.json
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': [
        'error',
        { singleQuote: true, semi: true, trailingComma: 'es5', printWidth: 80 },
      ],

      // Prefer the TypeScript-aware versions of some rules
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'no-undef': 'off', // TypeScript handles this for TS files

      // Keep some rules permissive during active development
      '@typescript-eslint/no-explicit-any': ['warn', { ignoreRestArgs: true }],
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      'no-unreachable': 'error',
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
    },
  },

  // JavaScript files (plain JS)
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
    },
  },

  // Test files — relaxed rules useful for test patterns
  {
    files: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-unused-expressions': 'off',
    },
  },
];
