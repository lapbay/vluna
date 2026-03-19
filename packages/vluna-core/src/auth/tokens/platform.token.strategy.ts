import { Inject, Injectable, OnModuleInit } from '@nestjs/common'
import type { TokenValidationStrategy, TokenDescriptor, TokenVerifyOptions } from './token.types.js'
import type { TokenClaims } from './token.types.js'
import { PlatformTokenService } from '../../security/platform-token.service.js'
import { TokenStrategyRegistry } from './token-strategy.registry.js'

const PLATFORM_KID_PREFIX = /^(plt|apt):/i

@Injectable()
export class PlatformTokenStrategy implements TokenValidationStrategy, OnModuleInit {
  readonly name = 'platform'

  constructor(
    @Inject(PlatformTokenService) private readonly platformTokens: PlatformTokenService,
    @Inject(TokenStrategyRegistry) private readonly registry: TokenStrategyRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this, 100)
  }

  async supports(descriptor: TokenDescriptor): Promise<boolean> {
    const kid = typeof descriptor.header?.kid === 'string' ? descriptor.header?.kid : undefined
    if (kid && PLATFORM_KID_PREFIX.test(kid)) return true
    const tokenUse = this.extractTokenUse(descriptor)
    return tokenUse === 'platform' || tokenUse === 'plt' || tokenUse === 'vluna' || tokenUse === 'apt'
  }

  async verify(descriptor: TokenDescriptor, options?: TokenVerifyOptions): Promise<TokenClaims> {
    return this.platformTokens.verify(descriptor.raw, options)
  }

  private extractTokenUse(descriptor: TokenDescriptor): string | undefined {
    const payload = descriptor.payload as Record<string, unknown> | null
    if (!payload) return undefined
    const tu = payload.tu || payload.token_use
    return typeof tu === 'string' ? tu.toLowerCase() : undefined
  }
}
