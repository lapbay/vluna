import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { BillingEventsController } from './controllers/billing-events.controller.js'
import { BillingContractsController } from './controllers/billing-contracts.controller.js'
import { BillingAccountsController } from './controllers/billing-accounts.controller.js'
import { EventRatingPoliciesController } from './controllers/event-rating-policies.controller.js'
import { FeatureFamiliesController } from './controllers/feature-families.controller.js'
import { FeaturesController } from './controllers/features.controller.js'
import { MetersController } from './controllers/meters.controller.js'
import { BillingPlansController } from './controllers/billing-plans.controller.js'
import { OpsController } from './controllers/ops.controller.js'
import { BudgetsService } from './services/budgets.service.js'
import { BudgetService } from '../../services/budget.service.js'
import { GrantBalanceService } from '../../services/grant-balance.service.js'
import { WalletService } from './services/wallet.service.js'
import { GateFeatureModule } from '../gate/gate.feature.module.js'
import { EventToRatingsService } from './services/event-to-ratings.service.js'
import { BillingContractsService } from './services/billing-contracts.service.js'
import { BillingAccountsService } from './services/billing-accounts.service.js'
import { EventRatingPoliciesService } from './services/event-rating-policies.service.js'
import { FeatureFamiliesService } from './services/feature-families.service.js'
import { FeaturesManagementService } from './services/features-management.service.js'
import { MetersManagementService } from './services/meters-management.service.js'
import { BillingPlansManagementService } from './services/billing-plans-management.service.js'

@Module({
  imports: [AuthModule, GateFeatureModule],
  controllers: [
    BillingEventsController,
    BillingAccountsController,
    BillingContractsController,
    EventRatingPoliciesController,
    FeatureFamiliesController,
    FeaturesController,
    MetersController,
    BillingPlansController,
    OpsController,
  ],
  providers: [
    BudgetsService,
    BudgetService,
    GrantBalanceService,
    WalletService,
    EventToRatingsService,
    BillingAccountsService,
    BillingContractsService,
    EventRatingPoliciesService,
    FeatureFamiliesService,
    FeaturesManagementService,
    MetersManagementService,
    BillingPlansManagementService,
  ],
  exports: [EventToRatingsService],
})
export class BillingManagementModule {}
