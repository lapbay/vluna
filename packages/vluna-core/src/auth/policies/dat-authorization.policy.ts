import type { AppRequest } from '../../types/app-request.js'

export const DAT_AUTHORIZATION_POLICY = Symbol('DAT_AUTHORIZATION_POLICY')
export const DAT_AUTHORIZATION_POLICY_OVERRIDE = Symbol('DAT_AUTHORIZATION_POLICY_OVERRIDE')

export type DatScope = 'mcp:read' | 'mcp:write'
export type DatBindingType = 'realm' | 'org'
export type DatSubjectType = 'operator'

export interface DatBootstrapPrincipal {
  token_id: string
  subject_type: DatSubjectType
  subject_id: string
  organization_id?: string
  allowed_realms: string[]
  granted_scopes: DatScope[]
}

export interface IssueDatSessionParams {
  req: AppRequest
  bootstrap: DatBootstrapPrincipal
  requested_scopes: DatScope[]
  requested_realm_id?: string
  requested_org_id?: string
  requested_binding?: DatBindingType
  requested_ttl_sec?: number
}

export interface IssueDatSessionFromBearerParams {
  req: AppRequest
  requested_scopes: DatScope[]
  requested_realm_id?: string
  requested_org_id?: string
  requested_binding?: DatBindingType
  requested_ttl_sec?: number
}

export interface DatSessionGrant {
  subject_type: DatSubjectType
  subject_id: string
  organization_id?: string
  binding_type: DatBindingType
  allowed_realms: string[]
  granted_scopes: DatScope[]
  default_realm?: string
  ttl_sec: number
}

export interface DatAuthorizationPolicy {
  issueSession(params: IssueDatSessionParams): Promise<DatSessionGrant>
  issueSessionFromBearer?(params: IssueDatSessionFromBearerParams): Promise<DatSessionGrant>
}
