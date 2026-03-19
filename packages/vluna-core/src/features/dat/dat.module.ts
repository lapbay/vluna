import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { DAT_AUTHORIZATION_POLICY } from '../../auth/policies/dat-authorization.policy.js'
import { DatController } from './controllers/dat.controller.js'
import { DatBootstrapAdminGuard } from './guards/dat-bootstrap-admin.guard.js'
import { DatBootstrapGuard } from './guards/dat-bootstrap.guard.js'
import { DatSessionIssueAuthGuard } from './guards/dat-session-issue-auth.guard.js'
import { DatSessionIssueRateLimitGuard } from './guards/dat-session-issue-rate-limit.guard.js'
import { OssDatAuthorizationPolicy } from './policies/oss-dat-authorization.policy.js'
import { DatAuthorizationResolver } from './services/dat-authorization.resolver.js'
import { DatBootstrapManagementService } from './services/dat-bootstrap-management.service.js'
import { DatBootstrapService } from './services/dat-bootstrap.service.js'
import { DatTokenService } from './services/dat-token.service.js'

@Module({
  imports: [AuthModule],
  controllers: [DatController],
  providers: [
    DatBootstrapService,
    DatBootstrapManagementService,
    DatBootstrapGuard,
    DatBootstrapAdminGuard,
    DatSessionIssueAuthGuard,
    DatSessionIssueRateLimitGuard,
    DatTokenService,
    OssDatAuthorizationPolicy,
    DatAuthorizationResolver,
    { provide: DAT_AUTHORIZATION_POLICY, useExisting: DatAuthorizationResolver },
  ],
  exports: [DatTokenService, DAT_AUTHORIZATION_POLICY],
})
export class DatModule {}
