import { Inject, Injectable, Optional } from '@nestjs/common'
import type {
  IssueMcpSessionParams,
  McpAuthorizationPolicy,
  McpRealmRef,
  McpSessionGrant,
} from '../../../auth/policies/mcp-authorization.policy.js'
import { MCP_AUTHORIZATION_POLICY_OVERRIDE } from '../../../auth/policies/mcp-authorization.policy.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { McpSessionClaims } from '../types/session.js'
import { OssMcpAuthorizationPolicy } from '../policies/oss-mcp-authorization.policy.js'

@Injectable()
export class McpAuthorizationResolver implements McpAuthorizationPolicy {
  constructor(
    @Inject(OssMcpAuthorizationPolicy) private readonly fallback: OssMcpAuthorizationPolicy,
    @Optional() @Inject(MCP_AUTHORIZATION_POLICY_OVERRIDE) private readonly override?: McpAuthorizationPolicy,
  ) {}

  issueSession(params: IssueMcpSessionParams): Promise<McpSessionGrant> {
    return (this.override || this.fallback).issueSession(params)
  }

  listRealmsForSession(req: AppRequest, claims: McpSessionClaims): Promise<McpRealmRef[]> {
    return (this.override || this.fallback).listRealmsForSession(req, claims)
  }
}
