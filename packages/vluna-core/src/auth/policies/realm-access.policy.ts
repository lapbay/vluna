import type { AppRequest } from '../../types/app-request.js'

export interface RealmAccessPolicy {
  allowBearerRealmAccess(request: AppRequest, realmId: string): Promise<boolean> | boolean
}

export const REALM_ACCESS_POLICY = Symbol('REALM_ACCESS_POLICY')
