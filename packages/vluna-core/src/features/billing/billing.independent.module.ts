import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { BillingDemoController } from '../billing/demo.controller.js'
import { StripeWebhooksController } from './controllers/stripe-webhooks.controller.js'

@Module({
  imports: [AuthModule],
  controllers: [BillingDemoController, StripeWebhooksController],
})
export class BillingIndependentModule {}
