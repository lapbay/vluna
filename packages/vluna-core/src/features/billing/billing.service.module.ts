import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { CatalogServiceController } from './controllers/catalog.controller.js'
import { CheckoutServiceController } from './controllers/checkout.controller.js'
import { PortalServiceController } from './controllers/portal.controller.js'
import { InvoicesServiceController } from './controllers/invoices.controller.js'
import { SubscriptionsServiceController } from './controllers/subscriptions.controller.js'
import { PaymentsServiceController } from './controllers/payments.controller.js'
import { WalletServiceController } from './controllers/wallet.controller.js'
import { BudgetsServiceController } from './controllers/budgets.controller.js'
import { GrantBalanceService } from '../../services/grant-balance.service.js'
import { WalletService } from './services/wallet.service.js'
import { BudgetsService } from './services/budgets.service.js'
import { SettlementService } from '../gate/services/settlement.service.js'
import { BudgetService } from '../../services/budget.service.js'
import { BillingPeriodService } from '../../services/billing-period.service.js'
import { CatalogApiService } from './services/catalog-api.service.js'
import { CheckoutApiService } from './services/checkout-api.service.js'
import { PortalApiService } from './services/portal-api.service.js'

@Module({
  imports: [AuthModule],
  controllers: [
    CatalogServiceController,
    CheckoutServiceController,
    PortalServiceController,
    InvoicesServiceController,
    SubscriptionsServiceController,
    PaymentsServiceController,
    WalletServiceController,
    BudgetsServiceController,
  ],
  providers: [
    GrantBalanceService,
    WalletService,
    BudgetsService,
    SettlementService,
    BudgetService,
    BillingPeriodService,
    CatalogApiService,
    CheckoutApiService,
    PortalApiService,
  ],
})
export class BillingCustomerServiceModule {}
