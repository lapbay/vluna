import type { PaymentProvider } from '../../providers/payment/PaymentProvider.js'
import { StripePaymentProvider } from '../../providers/stripe/provider.js'
import type { RealmConfigService } from '../../security/realm-config.service.js'

export function createStripePaymentProvider(realmConfig: RealmConfigService): PaymentProvider {
  return new StripePaymentProvider(realmConfig)
}
