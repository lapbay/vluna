import type { RequestContext } from '../../types/request-context.js'

export function allowCrossAccountAccess(ctx?: RequestContext): boolean {
  return ctx?.isRealmAdmin === true || ctx?.serviceAccessAllowed === true || ctx?.authScheme === 'service'
}
