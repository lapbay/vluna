import { Injectable } from '@nestjs/common'
import type { TokenValidationStrategy } from './token.types.js'

interface Entry {
  strategy: TokenValidationStrategy
  priority: number
}

@Injectable()
export class TokenStrategyRegistry {
  private readonly entries: Entry[] = []

  register(strategy: TokenValidationStrategy, priority = 0): void {
    if (!strategy) return
    const existing = this.entries.find((entry) => entry.strategy === strategy)
    if (existing) {
      existing.priority = priority
      return
    }
    this.entries.push({ strategy, priority })
    this.entries.sort((a, b) => b.priority - a.priority)
  }

  list(): TokenValidationStrategy[] {
    return this.entries.map((entry) => entry.strategy)
  }
}
