import { HttpException, Injectable } from '@nestjs/common'
import type {
  DatAuthorizationPolicy,
  DatScope,
  DatSessionGrant,
  IssueDatSessionFromBearerParams,
  IssueDatSessionParams,
} from '../../../auth/policies/dat-authorization.policy.js'

const DEFAULT_SCOPES: DatScope[] = ['mcp:read', 'mcp:write']

@Injectable()
export class OssDatAuthorizationPolicy implements DatAuthorizationPolicy {
  async issueSession(params: IssueDatSessionParams): Promise<DatSessionGrant> {
    const requestedBinding = params.requested_binding === 'org' ? 'org' : 'realm'
    const allowedRealms = Array.from(new Set(params.bootstrap.allowed_realms.map((value) => String(value || '').trim()).filter(Boolean)))
    if (!allowedRealms.length) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'bootstrap token has no allowed realms' }, 403)
    }

    const requestedOrgId = String(params.requested_org_id || '').trim()
    const organizationId = String(params.bootstrap.organization_id || '').trim() || undefined
    if (requestedOrgId && requestedOrgId !== organizationId) {
      throw new HttpException({ code: 'AUTH.ORGANIZATION_FORBIDDEN', message: 'requested_org_id is not allowed' }, 403)
    }
    if (requestedBinding === 'org' && !organizationId) {
      throw new HttpException({ code: 'AUTH.ORGANIZATION_FORBIDDEN', message: 'organization binding is not available' }, 403)
    }

    const selectedRealm = String(params.requested_realm_id || '').trim()
    if (selectedRealm && !allowedRealms.includes(selectedRealm)) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'requested realm not allowed' }, 403)
    }

    const bootstrapScopes = params.bootstrap.granted_scopes.length ? params.bootstrap.granted_scopes : DEFAULT_SCOPES
    const requestedScopes = params.requested_scopes.length ? params.requested_scopes : bootstrapScopes
    const grantedScopes = requestedScopes.filter((scope): scope is DatScope => bootstrapScopes.includes(scope))
    if (!grantedScopes.length) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'requested scopes are not allowed' }, 403)
    }

    return {
      subject_type: 'operator',
      subject_id: params.bootstrap.subject_id,
      organization_id: organizationId,
      binding_type: requestedBinding,
      allowed_realms: allowedRealms,
      granted_scopes: grantedScopes,
      default_realm: selectedRealm || allowedRealms[0],
      ttl_sec: params.requested_ttl_sec ?? 900,
    }
  }

  async issueSessionFromBearer(_params: IssueDatSessionFromBearerParams): Promise<DatSessionGrant> {
    throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'bootstrap token required' }, 401)
  }
}
