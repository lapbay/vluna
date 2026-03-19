/// <reference types="vitest" />
import 'vitest'

declare module 'vitest' {
  interface TestOptions {
    tags?: string | string[]
  }
  interface SuiteOptions {
    tags?: string | string[]
  }
}
