import type { AppRequest } from '../../types/app-request.js'

export interface ServiceAccessPolicy {
  allowBearerServiceAccess(request: AppRequest): Promise<boolean> | boolean
}

export const SERVICE_ACCESS_POLICY = Symbol('SERVICE_ACCESS_POLICY')
