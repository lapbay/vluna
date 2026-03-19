import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { McpController } from './controllers/mcp.controller.js'
import { McpSessionTokenService } from './services/mcp-session-token.service.js'
import { McpSessionGuard } from './services/mcp-session.guard.js'
import {
  MCP_AUTHORIZATION_POLICY,
} from '../../auth/policies/mcp-authorization.policy.js'
import { OssMcpAuthorizationPolicy } from './policies/oss-mcp-authorization.policy.js'
import { McpAuthorizationResolver } from './services/mcp-authorization.resolver.js'

@Module({
  imports: [AuthModule],
  controllers: [McpController],
  providers: [
    McpSessionTokenService,
    McpSessionGuard,
    OssMcpAuthorizationPolicy,
    McpAuthorizationResolver,
    { provide: MCP_AUTHORIZATION_POLICY, useExisting: McpAuthorizationResolver },
  ],
  exports: [McpSessionTokenService, McpSessionGuard, MCP_AUTHORIZATION_POLICY],
})
export class McpModule {}
