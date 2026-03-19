import { CanActivate, ExecutionContext, Injectable, HttpException } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'

type ProviderMap = { provider: string; customer_id?: string; realm_id?: string; billing_account_id: string }

function loadProviderMap(): ProviderMap[] {
  const raw = process.env.VLUNA_PROVIDER_ACCOUNT_MAP || ''
  if (!raw) return []
  try { return JSON.parse(raw) as ProviderMap[] } catch { return [] }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveFromStripeWebhook(req: any): { provider: string; customer_id?: string } | null {
  const event = req?.body
  const customer = event?.data?.object?.customer || event?.data?.object?.client_reference_id || undefined
  if (customer) return { provider: 'stripe', customer_id: String(customer) }
  const hdr = req?.headers?.['x-stripe-customer-id']
  if (hdr) return { provider: 'stripe', customer_id: String(hdr) }
  return null
}

@Injectable()
export class ProviderAccountGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    // Demo: derive realm from URL params rather than headers (e.g., /webhooks/stripe/:realm_id/events)
    const params = (req?.params as Record<string, unknown>) || {}
    const realmId: string | undefined = String(params?.realm_id || params?.realmId || '') || undefined
    const p = resolveFromStripeWebhook(req)
    if (!p) throw new HttpException('provider_identity_missing', 400)
    const table = loadProviderMap()
    const hit = table.find(e => e.provider === p.provider && (!e.realm_id || e.realm_id === realmId) && (!e.customer_id || e.customer_id === p.customer_id))
    if (!hit?.billing_account_id) throw new HttpException('provider_identity_not_mapped_use_s2s', 409)
    req.ctx = req.ctx || {}
    req.ctx.billingAccountId = hit.billing_account_id
    return true
  }
}
