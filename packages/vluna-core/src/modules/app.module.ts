import { createAppModule } from '../platform/app-module.builder.js'
import { parseRuntimeArgsFromArgv } from '../platform/runtime-args.js'

export const AppModule = createAppModule()

export const createAppModuleFromProcessArgv = () =>
  createAppModule({ runtimeArgs: parseRuntimeArgsFromArgv(process.argv.slice(2)) })
