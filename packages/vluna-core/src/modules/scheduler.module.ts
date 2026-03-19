import { Module, type DynamicModule } from '@nestjs/common'
import { PERIODIC_TASKS, PERIODIC_TASKS_ALL, type PeriodicTaskDefinition } from '../scheduler/periodic-task.types.js'
import { PeriodicTaskRunner } from '../scheduler/periodic-task.runner.js'
import { GrantBindingSweepTask } from '../tasks/grant-binding-sweep.task.js'
import { GrantExpirySweepTask } from '../tasks/grant-expiry-sweep.task.js'
import { GrantBindingEnrollmentService } from '../services/grant-binding-enrollment.service.js'
import { SettlementSweepTask } from '../tasks/settlement-sweep.task.js'
import { OutcomeBillingSweepTask } from '../tasks/outcome-billing-sweep.task.js'
import { BillingCloseoutSweepTask } from '../tasks/billing-closeout-sweep.task.js'
import { SeatUsageSweepTask } from '../tasks/seat-usage-sweep.task.js'
import { GateFeatureModule } from '../features/gate/gate.feature.module.js'
import { BillingManagementModule } from '../features/billing/billing.management.module.js'
import { RUNTIME_ARGS, type RuntimeArgs } from '../platform/runtime-args.js'
import { selectPeriodicTasksByName } from '../scheduler/task-filter.js'

@Module({
  imports: [GateFeatureModule, BillingManagementModule],
  providers: [
    GrantBindingSweepTask,
    GrantExpirySweepTask,
    SettlementSweepTask,
    OutcomeBillingSweepTask,
    BillingCloseoutSweepTask,
    SeatUsageSweepTask,
    GrantBindingEnrollmentService,
    {
      provide: PERIODIC_TASKS_ALL,
      useFactory: (
        bindingTask: GrantBindingSweepTask,
        expiryTask: GrantExpirySweepTask,
        settlementTask: SettlementSweepTask,
        outcomeTask: OutcomeBillingSweepTask,
        closeoutTask: BillingCloseoutSweepTask,
        seatUsageTask: SeatUsageSweepTask,
      ) => [bindingTask, expiryTask, settlementTask, outcomeTask, closeoutTask, seatUsageTask],
      inject: [GrantBindingSweepTask, GrantExpirySweepTask, SettlementSweepTask, OutcomeBillingSweepTask, BillingCloseoutSweepTask, SeatUsageSweepTask],
    },
    {
      provide: PERIODIC_TASKS,
      useFactory: (allTasks: PeriodicTaskDefinition[], runtimeArgs: RuntimeArgs) =>
        selectPeriodicTasksByName(allTasks, runtimeArgs),
      inject: [PERIODIC_TASKS_ALL, RUNTIME_ARGS],
    },
    PeriodicTaskRunner,
  ],
})
export class SchedulerModule {
  static forRoot(runtimeArgs: RuntimeArgs): DynamicModule {
    return {
      module: SchedulerModule,
      providers: [{ provide: RUNTIME_ARGS, useValue: runtimeArgs }],
    }
  }
}
