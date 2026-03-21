import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common'
import { RouterModule, type RouteTree } from '@nestjs/core'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { SecurityModule } from '../security/security.module.js'
import { TokensModule } from '../auth/tokens/tokens.module.js'
import { HealthModule } from '../modules/health.module.js'
import { BillingPublicModule } from '../features/billing/billing.public.module.js'
import { BillingManagementModule } from '../features/billing/billing.management.module.js'
import { BillingCustomerServiceModule } from '../features/billing/billing.service.module.js'
import { GateFeatureModule } from '../features/gate/gate.feature.module.js'
import { BillingIndependentModule } from '../features/billing/billing.independent.module.js'
import { ScatteredApiModule } from '../features/system/scattered-api.module.js'
import { SchedulerModule } from '../modules/scheduler.module.js'
import { DatModule } from '../features/dat/dat.module.js'
import { AdminPlaneModule } from '../modules/admin-plane.module.js'
import { AuditModule } from '../support/audit.module.js'
import type { RuntimeArgs } from './runtime-args.js'

type NestImport = Type | DynamicModule

export type RouteModule = Type

export interface PlatformModuleOptions {
  imports?: NestImport[]
  providers?: Provider[]
  adminPlaneProvider?: Provider
  apiChildren?: RouteTree[]
  managementChildren?: RouteTree[]
  runtimeArgs?: RuntimeArgs
}

export const createAppModule = (options: PlatformModuleOptions = {}) => {
  const baseApiChildren: RouteTree[] = [
    { path: 'v1', module: BillingPublicModule },
    { path: 'v1', module: ScatteredApiModule },
    { path: '/', module: BillingIndependentModule },
  ]
  const baseManagementChildren: RouteTree[] = [
    { path: 'v1', module: SecurityModule },
    { path: 'v1', module: BillingManagementModule },
    { path: 'v1', module: DatModule },
    { path: 'v1', module: GateFeatureModule },
    { path: 'v1', module: BillingCustomerServiceModule },
  ]

  const apiChildren = [...baseApiChildren, ...(options.apiChildren ?? [])]
  const managementChildren = [...baseManagementChildren, ...(options.managementChildren ?? [])]

  const imports: NestImport[] = [
    EventEmitterModule.forRoot(),
    AuditModule,
    HealthModule,
    TokensModule,
    SecurityModule,
    AdminPlaneModule.forRoot(options.adminPlaneProvider),
    ScatteredApiModule,
    BillingPublicModule,
    BillingManagementModule,
    DatModule,
    BillingIndependentModule,
    BillingCustomerServiceModule,
    GateFeatureModule,
    SchedulerModule.forRoot(options.runtimeArgs ?? {}),
    ...(options.imports ?? []),
    RouterModule.register([
      { path: 'api', children: apiChildren },
      { path: 'mgt', children: managementChildren },
      { path: '', module: HealthModule },
    ]),
  ]

  const providers = [...(options.providers ?? [])]

  @Module({ imports, providers })
  class AppModule {}

  return AppModule
}
