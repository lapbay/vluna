import type { DatBindingType, DatScope, DatSubjectType } from '../../../auth/policies/dat-authorization.policy.js'

export interface DatSessionClaims {
  sub: string
  aud: string
  iss: string
  iat: number
  exp: number
  jti: string
  token_use: 'dat'
  tu: 'dat'
  edition: string
  subject_type: DatSubjectType
  subject_id: string
  organization_id?: string
  binding_type: DatBindingType
  allowed_realms: string[]
  granted_scopes: DatScope[]
  selected_realm?: string
}

