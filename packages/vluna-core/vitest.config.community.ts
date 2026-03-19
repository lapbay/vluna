import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    dir: 'tests',
    exclude: ['dist/**', 'node_modules/**', '**/enterprise/**', '**/postgres/**'],
    env: {
      VLUNA_EDITION: 'community',
    },
  },
  resolve: {
    alias: {},
  },
})
