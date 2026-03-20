import type { RealmAuthProfile } from '../../security/realm-config.service.js'
import type { AppRequest } from '../../types/app-request.js'

export const SCOPE_BYPASS_POLICY = Symbol('SCOPE_BYPASS_POLICY')

export interface ScopeBypassPolicy {
  allowCanonicalScopes(req: AppRequest, requiredScopes: string[], profile?: RealmAuthProfile | null): Promise<boolean>
}
