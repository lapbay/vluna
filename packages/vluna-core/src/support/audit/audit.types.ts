import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../../types/app-request.js'

export type AuditScopeType = 'realm' | 'platform'

export type AuditActorType = 'user' | 'organization' | 'service_key' | 'dat_session' | 'cli' | 'platform' | 'system'

export type AuditStatus = 'success' | 'failure'

export type AuditValueResolverContext = {
  req: AppRequest
  reply: FastifyReply
  responseBody?: unknown
  error?: unknown
}

export type AuditValueResolver = string | ((ctx: AuditValueResolverContext) => string | null | undefined)

export type AuditSuccessEvaluator = (ctx: AuditValueResolverContext) => boolean

export type AuditOptions = {
  action: AuditValueResolver
  operationId?: string
  targetType?: string
  targetIdFrom?: AuditValueResolver
  redact?: string[]
  mask?: string[]
  captureResponse?: boolean
  responseRedact?: string[]
  responseMask?: string[]
  disable?: boolean
  successEvaluator?: AuditSuccessEvaluator
}

export type ResolvedAuditActor = {
  actorType: AuditActorType
  actorId?: string
  actorDisplay?: string
}

export type ResolvedAuditScope = {
  scopeType: AuditScopeType
  realmId?: string
}

export type AuditLogInsert = {
  scopeType: AuditScopeType
  realmId?: string
  actorType: AuditActorType
  actorId?: string
  actorDisplay?: string
  authScheme?: string
  action: string
  targetType?: string
  targetId?: string
  operationId?: string
  method: string
  path: string
  routeTemplate?: string
  status: AuditStatus
  httpStatus: number
  errorCode?: string
  traceId?: string
  paramsJson?: unknown
  queryJson?: unknown
  bodyJsonRedacted?: unknown
  responseJsonRedacted?: unknown
  metadata?: Record<string, unknown>
}
