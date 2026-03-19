import type { TokenClaims, TokenValidator, TokenVerifyOptions } from './token.types.js'

export class NoopTokenValidator implements TokenValidator {
  async verify(_token: string, _options?: TokenVerifyOptions): Promise<TokenClaims> {
    throw new Error('Token validation disabled (strategy=none)')
  }
}
