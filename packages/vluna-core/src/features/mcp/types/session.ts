import type { McpScope } from '../../../auth/policies/mcp-authorization.policy.js'

export interface McpSessionClaims {
  sub: string
  aud: string
  iss: string
  iat: number
  exp: number
  jti: string
  token_use: 'mcp'
  tu: 'mcp'
  edition: string
  subject_type: 'service_key' | 'user'
  subject_id: string
  organization_id?: string
  binding_type: 'realm' | 'org'
  allowed_realms: string[]
  granted_scopes: McpScope[]
  selected_realm?: string
}
