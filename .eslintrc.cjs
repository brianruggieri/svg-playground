/**
 * Legacy ESLint configuration (CommonJS) so ESLint in CI/Actions can find a config file.
 *
 * This mirrors the project's eslintConfig in package.json and keeps using
 * @typescript-eslint/parser + plugin and prettier integration.
 *
 * If you later migrate to the flat config (eslint.config.js), you can replace this file.
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
    // If you enable rules that require type information, add:
    // project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended'
  ],
  rules: {
    // Keep Prettier integration as an error to surface formatting problems in CI
    'prettier/prettier': 'error'
    // Add any project-specific ESLint rules here
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.min.js'
  ],
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
        // If type-aware rules are added, point to tsconfig.json:
        // project: ['./tsconfig.json']
      },
      rules: {
        // TypeScript-specific rule overrides can go here
      }
    },
    {
      files: ['*.js'],
      env: {
        browser: true,
        node: true,
        es2022: true
      },
      rules: {
        // JS-specific overrides (if any)
      }
    }
  ]
};
