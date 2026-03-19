import { Module } from '@nestjs/common'
import { HealthController } from '../features/system/health.controller.js'

@Module({ controllers: [HealthController] })
export class HealthModule {}
