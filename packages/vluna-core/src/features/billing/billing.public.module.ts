import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { CatalogPublicController } from './controllers/catalog.controller.js'
import { CheckoutPublicController } from './controllers/checkout.controller.js'
import { PortalPublicController } from './controllers/portal.controller.js'
import { InvoicesPublicController } from './controllers/invoices.controller.js'
import { SubscriptionsPublicController } from './controllers/subscriptions.controller.js'
import { PaymentsPublicController } from './controllers/payments.controller.js'
import { BudgetsController } from './controllers/budgets.controller.js'
import { GrantBalanceService } from '../../services/grant-balance.service.js'
import { WalletService } from './services/wallet.service.js'
import { BudgetsService } from './services/budgets.service.js'
import { SettlementService } from '../gate/services/settlement.service.js'
import { BudgetService } from '../../services/budget.service.js'
import { WalletController } from './controllers/wallet.controller.js'
import { BillingPeriodService } from '../../services/billing-period.service.js'
import { CatalogApiService } from './services/catalog-api.service.js'
import { CheckoutApiService } from './services/checkout-api.service.js'
import { PortalApiService } from './services/portal-api.service.js'

@Module({
  imports: [AuthModule],
  controllers: [
    CatalogPublicController,
    CheckoutPublicController,
    PortalPublicController,
    InvoicesPublicController,
    SubscriptionsPublicController,
    PaymentsPublicController,
    WalletController,
    BudgetsController,
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
  exports: [CatalogApiService, CheckoutApiService, PortalApiService],
})
export class BillingPublicModule {}
