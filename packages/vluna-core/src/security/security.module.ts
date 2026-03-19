import { Module } from '@nestjs/common'
import { ServiceApiKeyService } from './service-api-key.service.js'
import { PlatformTokenService } from './platform-token.service.js'
import { TokenController } from './token.controller.js'
import { RealmConfigService } from './realm-config.service.js'

@Module({
  providers: [ServiceApiKeyService, PlatformTokenService, RealmConfigService],
  controllers: [TokenController],
  exports: [ServiceApiKeyService, PlatformTokenService, RealmConfigService],
})
export class SecurityModule {}
