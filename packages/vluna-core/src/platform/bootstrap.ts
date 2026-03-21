import 'dotenv/config'
import 'reflect-metadata'
import type { Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { fastifyCors } from '@fastify/cors'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { EnvelopeInterceptor } from '../support/envelope.interceptor.js'
import { GlobalExceptionFilter } from '../support/global-exception.filter.js'
import { TraceMiddleware } from '../support/trace.middleware.js'
import { TraceHeadersInterceptor } from '../support/trace-headers.interceptor.js'
import { ExposeHeadersInterceptor } from '../support/expose-headers.interceptor.js'
import { PermissionsChangedInterceptor } from '../support/permissions-changed.interceptor.js'
import { DbSessionInterceptor } from '../support/db-session.interceptor.js'
import { AuditInterceptor } from '../support/audit/audit.interceptor.js'
import { ValidationPipe } from '@nestjs/common'
import { ServiceApiKeyService } from '../security/service-api-key.service.js'
import { setupDatabaseWithGuards } from '../db/setup.js'
import { DB_SCHEMA } from '../db/schema.js'
import { getPlaneTags } from '../config/plane.js'

type BootstrapOptions = {
  migrationDirs: string[]
  skipMigrations?: boolean
}

export const bootstrapApp = async (AppModule: Type, opts?: BootstrapOptions) => {
  const planeTags = getPlaneTags()
  console.log(JSON.stringify({ at: 'bootstrap.start', ...planeTags, db_schema: DB_SCHEMA }))

  const migrationDirs = opts?.migrationDirs
  const shouldRunMigrations = opts?.skipMigrations !== true && process.env.VLUNA_SKIP_DB_MIGRATIONS !== '1'
  if (shouldRunMigrations) {
    if (!migrationDirs || migrationDirs.length === 0) {
      throw new Error('migrationDirs are required for bootstrapApp when migrations are enabled')
    }
    await setupDatabaseWithGuards({ migrationDirs })
  }

  const isProd = process.env.NODE_ENV?.toLowerCase() === 'production'
  const isSmoke = process.env.VLUNA_SMOKE_TEST === '1'
  const adapter = new FastifyAdapter({
    logger: isProd
      ? {
          level: process.env.LOG_LEVEL || 'info',
          redact: { paths: ['req.headers.authorization'], censor: '***' },
        }
      : {
          level: process.env.LOG_LEVEL || 'info',
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              singleLine: true,
              ignore: 'pid,hostname',
            },
          },
          redact: { paths: ['req.headers.authorization'], censor: '***' },
        },
    disableRequestLogging: false,
    ignoreTrailingSlash: true,
  })
  const app = await NestFactory.create(AppModule, adapter, { rawBody: true })
  const fastify = app.getHttpAdapter().getInstance()

  try {
    await fastify.register(fastifyCors, {
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      origin: [
        'http://localhost:5173',
        /^https?:\/\/bayesi\.com(?::\d+)?$/,
        /^https?:\/\/api\.bayesi\.com(?::\d+)?$/,
        /^https?:\/\/web\.gate\.tapray\.com(?::\d+)?$/,
        /^https?:\/\/bg\.gate\.tapray\.com(?::\d+)?$/,
      ],
    })
  } catch (e) {
    console.warn('fastify-cors not registered:', e)
  }

  app.enableShutdownHooks()
  app.useGlobalInterceptors(
    new DbSessionInterceptor(),
    app.get(AuditInterceptor),
    new EnvelopeInterceptor(),
    new TraceHeadersInterceptor(),
    new PermissionsChangedInterceptor(),
    new ExposeHeadersInterceptor(),
  )
  if (isProd) app.useGlobalFilters(new GlobalExceptionFilter())
  app.use(new TraceMiddleware().use)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))

  await app.init()

  if (isSmoke) {
    console.log('[smoke] Initialized vluna app - skipping listener start')
    await app.close()
    return
  }

  const serviceApiKeyService = app.get(ServiceApiKeyService)
  await serviceApiKeyService.loadSecrets()

  const port = Number(process.env.PORT || 3002)
  const host = process.env.HOST || '0.0.0.0'
  await app.listen(port, host)

  console.log(JSON.stringify({ at: 'bootstrap.ready', ...planeTags, db_schema: DB_SCHEMA, host, port }))
}
