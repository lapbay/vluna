// Flat ESLint config for vluna (ESLint v9+)
import path from 'node:path'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import importPlugin from 'eslint-plugin-import'

const tsconfigRoot = path.dirname(new URL(import.meta.url).pathname)

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  // Non-type-aware lint for top-level scripts
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin, import: importPlugin },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js', '.ts'] },
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      'import/extensions': ['error', 'always', { js: 'always', ts: 'always', ignorePackages: true }],
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tests/tsconfig.json'],
        tsconfigRootDir: tsconfigRoot,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    settings: { 'import/resolver': { node: { extensions: ['.js', '.ts'] } } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@vluna/vluna-enterprise', '@vluna/vluna-enterprise/*', '**/enterprise/**'],
        },
      ],
      'no-console': 'off',
      'import/extensions': ['error', 'always', { js: 'always', ts: 'always', ignorePackages: true }],
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: tsconfigRoot,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    settings: { 'import/resolver': { node: { extensions: ['.js', '.ts'] } } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'import/extensions': ['error', 'always', { js: 'always', ts: 'always', ignorePackages: true }],
      'import/no-unresolved': 'off',
    },
  },
]
