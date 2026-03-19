import { StripePaymentProvider } from './provider.js'
import { newTraceId } from '../../support/trace.util.js'
import type { ProviderOpContext } from '../payment/PaymentProvider.js'
import { db as getDb } from '../../db/index.js'
import type { RealmConfigService } from '../../security/realm-config.service.js'

export async function tryDemoStripeSync(realmConfig: RealmConfigService, realmId?: string) {
  const resolvedRealm = realmId
  try {
    await realmConfig.getStripeRuntime(resolvedRealm)
  } catch (err) {
    console.log('[stripe-demo] skip (realm missing Stripe config)', { realmId: resolvedRealm, error: (err as Error)?.message })
    return
  }
  try {
    const provider = new StripePaymentProvider(realmConfig)
    const ctx: ProviderOpContext = { traceId: newTraceId(), realmId: resolvedRealm, db: getDb() }
    const report = await provider.syncProductsAndPrices(ctx, { dryRun: false })
    console.log('[stripe-demo] sync finished', JSON.stringify({ counters: report.counters, notes: report.notes.slice(0, 5) }))
  } catch (e) {
    console.warn('[stripe-demo] sync failed:', e)
  }
}
