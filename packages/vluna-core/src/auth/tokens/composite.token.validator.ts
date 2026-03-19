import { Inject, Injectable } from '@nestjs/common'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import type { TokenValidator, TokenClaims, TokenVerifyOptions, TokenDescriptor, TokenValidationStrategy } from './token.types.js'
import { TokenStrategyRegistry } from './token-strategy.registry.js'

@Injectable()
export class CompositeTokenValidator implements TokenValidator {
  constructor(@Inject(TokenStrategyRegistry) private readonly registry: TokenStrategyRegistry) {}

  async verify(token: string, options?: TokenVerifyOptions): Promise<TokenClaims> {
    const descriptor = this.describe(token)
    const strategies = this.registry.list()
    for (const strategy of strategies) {
      if (await this.isSupported(strategy, descriptor, options)) {
        return strategy.verify(descriptor, options)
      }
    }
    throw new Error('unsupported_token')
  }

  private describe(token: string): TokenDescriptor {
    return {
      raw: token,
      header: this.safeDecodeHeader(token),
      payload: this.safeDecodePayload(token),
    }
  }

  private safeDecodeHeader(token: string) {
    try {
      return decodeProtectedHeader(token)
    } catch {
      return null
    }
  }

  private safeDecodePayload(token: string) {
    try {
      return decodeJwt(token)
    } catch {
      return null
    }
  }

  private async isSupported(
    strategy: TokenValidationStrategy,
    descriptor: TokenDescriptor,
    options?: TokenVerifyOptions,
  ): Promise<boolean> {
    try {
      return await strategy.supports(descriptor, options)
    } catch {
      return false
    }
  }
}
