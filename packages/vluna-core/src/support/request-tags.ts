import type { RequestContext } from '../types/request-context.js'
import { getPlaneTags } from '../config/plane.js'

export function buildRequestTags(ctx?: RequestContext): Record<string, unknown> {
  return {
    ...getPlaneTags(),
    request_id: ctx?.traceId,
    realm_id: ctx?.realmId,
    billing_account_id: ctx?.billingAccountId,
  }
}
