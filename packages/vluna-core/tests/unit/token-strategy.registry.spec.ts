import { describe, it, expect, vi } from 'vitest'
import { CompositeTokenValidator } from '../../src/auth/tokens/composite.token.validator.js'
import { TokenStrategyRegistry } from '../../src/auth/tokens/token-strategy.registry.js'
import type { TokenValidationStrategy, TokenDescriptor, TokenClaims, TokenVerifyOptions } from '../../src/auth/tokens/token.types.js'

class FakeStrategy implements TokenValidationStrategy {
  constructor(public readonly name: string, private readonly supportsFlag: boolean) {}
  async supports(descriptor: TokenDescriptor): Promise<boolean> {
    return this.supportsFlag && descriptor.raw.startsWith(this.name)
  }
  async verify(descriptor: TokenDescriptor, _opts?: TokenVerifyOptions): Promise<TokenClaims> {
    return { sub: descriptor.raw, iss: this.name }
  }
}

describe('TokenStrategyRegistry', { tags: ['unit'] }, () => {
  it('registers strategies once and keeps priority ordering', () => {
    const registry = new TokenStrategyRegistry()
    const s1 = new FakeStrategy('a', true)
    const s2 = new FakeStrategy('b', true)
    registry.register(s1, 1)
    registry.register(s2, 10)
    registry.register(s1, 0) // update priority

    const list = registry.list()
    expect(list[0]).toBe(s2)
    expect(list[1]).toBe(s1)
  })
})

describe('CompositeTokenValidator', { tags: ['unit'] }, () => {
  it('uses first supporting strategy', async () => {
    const registry = new TokenStrategyRegistry()
    const supporting = new FakeStrategy('ok', true)
    const blocking = new FakeStrategy('block', false)
    registry.register(blocking, 5)
    registry.register(supporting, 1)

    const validator = new CompositeTokenValidator(registry)
    const claims = await validator.verify('ok-token')
    expect(claims.iss).toBe('ok')
  })

  it('throws when no strategy supports the token', async () => {
    const registry = new TokenStrategyRegistry()
    registry.register(new FakeStrategy('none', false))
    const validator = new CompositeTokenValidator(registry)
    await expect(validator.verify('unsupported')).rejects.toThrow('unsupported_token')
  })

  it('ignores strategy errors during supports', async () => {
    const registry = new TokenStrategyRegistry()
    const bad: TokenValidationStrategy = {
      name: 'bad',
      supports: vi.fn().mockRejectedValue(new Error('boom')),
      verify: vi.fn(),
    }
    registry.register(bad, 1)
    const validator = new CompositeTokenValidator(registry)
    await expect(validator.verify('x')).rejects.toThrow('unsupported_token')
  })
})
