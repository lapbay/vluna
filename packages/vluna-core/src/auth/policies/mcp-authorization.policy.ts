import type { AppRequest } from '../../types/app-request.js'
import type { McpSessionClaims } from '../../features/mcp/types/session.js'

export const MCP_AUTHORIZATION_POLICY = Symbol('MCP_AUTHORIZATION_POLICY')
export const MCP_AUTHORIZATION_POLICY_OVERRIDE = Symbol('MCP_AUTHORIZATION_POLICY_OVERRIDE')

export type McpScope = 'mcp:read' | 'mcp:write'

export interface McpRealmRef {
  realm_id: string
  name?: string | null
  is_default?: boolean
}

export interface McpSessionGrant {
  subject_type: 'service_key' | 'user'
  subject_id: string
  organization_id?: string
  binding_type: 'realm' | 'org'
  allowed_realms: string[]
  granted_scopes: McpScope[]
  default_realm?: string
  ttl_sec: number
}

export interface IssueMcpSessionParams {
  req: AppRequest
  requested_scopes: McpScope[]
  requested_realm_id?: string
  requested_org_id?: string
  requested_binding?: 'realm' | 'org'
  requested_ttl_sec?: number
}

export interface McpAuthorizationPolicy {
  issueSession(params: IssueMcpSessionParams): Promise<McpSessionGrant>
  listRealmsForSession(req: AppRequest, claims: McpSessionClaims): Promise<McpRealmRef[]>
}
