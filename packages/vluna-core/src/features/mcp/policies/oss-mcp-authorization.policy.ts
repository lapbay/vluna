import { HttpException, Injectable } from '@nestjs/common'
import type {
  IssueMcpSessionParams,
  McpAuthorizationPolicy,
  McpRealmRef,
  McpScope,
  McpSessionGrant,
} from '../../../auth/policies/mcp-authorization.policy.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { McpSessionClaims } from '../types/session.js'

const DEFAULT_SCOPES: McpScope[] = ['mcp:read', 'mcp:write']

@Injectable()
export class OssMcpAuthorizationPolicy implements McpAuthorizationPolicy {
  async issueSession(params: IssueMcpSessionParams): Promise<McpSessionGrant> {
    const req = params.req
    const requestedScopes = params.requested_scopes.length ? params.requested_scopes : DEFAULT_SCOPES
    const serviceKey = req.ctx?.serviceApiKey
    if (serviceKey) {
      const allowedByKey = serviceKey.allowedRealms.length ? serviceKey.allowedRealms : [String(req.ctx?.realmId || '').trim()].filter(Boolean)
      if (!allowedByKey.length) {
        throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm context required' }, 400)
      }
      const selected = params.requested_realm_id?.trim()
      if (selected && !allowedByKey.includes(selected)) {
        throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'requested realm not allowed by service key' }, 403)
      }
      return {
        subject_type: 'service_key',
        subject_id: serviceKey.keyId,
        binding_type: params.requested_binding === 'org' ? 'org' : 'realm',
        allowed_realms: allowedByKey,
        granted_scopes: requestedScopes,
        default_realm: selected || allowedByKey[0],
        ttl_sec: params.requested_ttl_sec ?? 900,
      }
    }

    const claims = req.ctx?.claims as Record<string, unknown> | undefined
    const subjectId = String(req.ctx?.sub || claims?.sub || '').trim()
    if (!subjectId) {
      throw new HttpException({ code: 'AUTH.MISSING_SUBJECT', message: 'subject missing' }, 401)
    }
    const realmId = String(params.requested_realm_id || req.ctx?.realmId || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm context required' }, 400)
    }
    return {
      subject_type: 'user',
      subject_id: subjectId,
      organization_id: toOptionalString(claims?.organization_id),
      binding_type: params.requested_binding === 'org' ? 'org' : 'realm',
      allowed_realms: [realmId],
      granted_scopes: requestedScopes,
      default_realm: realmId,
      ttl_sec: params.requested_ttl_sec ?? 900,
    }
  }

  async listRealmsForSession(_req: AppRequest, claims: McpSessionClaims): Promise<McpRealmRef[]> {
    return claims.allowed_realms.map((realmId) => ({
      realm_id: realmId,
      is_default: realmId === claims.selected_realm,
    }))
  }
}

function toOptionalString(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}
