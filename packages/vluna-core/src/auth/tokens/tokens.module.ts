import { Module, Global } from '@nestjs/common'
import { TOKEN_VALIDATOR } from './token.types.js'
import { NoopTokenValidator } from './noop.token.validator.js'
import { SecurityModule } from '../../security/security.module.js'
import { CompositeTokenValidator } from './composite.token.validator.js'
import { TokenStrategyRegistry } from './token-strategy.registry.js'
import { PlatformTokenStrategy } from './platform.token.strategy.js'

@Global()
@Module({
  imports: [SecurityModule],
  providers: [
    TokenStrategyRegistry,
    PlatformTokenStrategy,
    {
      provide: CompositeTokenValidator,
      useFactory: (registry: TokenStrategyRegistry) => new CompositeTokenValidator(registry),
      inject: [TokenStrategyRegistry],
    },
    {
      provide: TOKEN_VALIDATOR,
      useFactory: (composite: CompositeTokenValidator) => {
        const strategy = (process.env.VLUNA_AUTH_STRATEGY || 'plt').toLowerCase()
        if (strategy === 'none') return new NoopTokenValidator()
        return composite
      },
      inject: [CompositeTokenValidator],
    },
  ],
  exports: [TOKEN_VALIDATOR, TokenStrategyRegistry],
})
export class TokensModule {}
