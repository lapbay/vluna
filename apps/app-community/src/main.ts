import { bootstrapApp } from '@vluna/vluna-core/platform/bootstrap'
import { resolveMigrationDirs } from '@vluna/vluna-core/db/resolve-migrations'
import { AppModule } from './app.module.js'

const migrationDirs = resolveMigrationDirs('community')

bootstrapApp(AppModule, { migrationDirs }).catch((err) => {
  console.error('Community fatal bootstrap error', err)
  process.exit(1)
})
