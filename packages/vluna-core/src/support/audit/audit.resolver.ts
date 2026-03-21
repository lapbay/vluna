import { HttpException } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../../types/app-request.js'
import type {
  AuditOptions,
  AuditValueResolver,
  AuditValueResolverContext,
  ResolvedAuditActor,
  ResolvedAuditScope,
} from './audit.types.js'

export function resolveAuditActor(req: AppRequest): ResolvedAuditActor {
  if (req.ctx?.serviceApiKey?.keyId) {
    return {
      actorType: 'service_key',
      actorId: String(req.ctx.serviceApiKey.keyId),
      actorDisplay: String(req.ctx.serviceApiKey.keyId),
    }
  }
  if (req.ctx?.datSession?.subject_id) {
    return {
      actorType: 'dat_session',
      actorId: String(req.ctx.datSession.subject_id),
      actorDisplay: String(req.ctx.datSession.subject_id),
    }
  }
  if (req.ctx?.platformToken) {
    const actorId = normalizeString(req.ctx.sub) ?? normalizeString(req.ctx.principal?.id)
    return {
      actorType: 'platform',
      actorId,
      actorDisplay: actorId,
    }
  }
  if (req.ctx?.sub || req.ctx?.userId) {
    const actorId = normalizeString(req.ctx.sub) ?? normalizeString(req.ctx.userId)
    return {
      actorType: 'user',
      actorId,
      actorDisplay: normalizeString(req.ctx.user?.name) ?? actorId,
    }
  }
  return { actorType: 'system' }
}

export function resolveAuditScope(req: AppRequest): ResolvedAuditScope {
  const realmId = normalizeString(req.ctx?.realmId)
  if (realmId) return { scopeType: 'realm', realmId }
  return { scopeType: 'platform' }
}

export function resolveAuditAction(
  resolver: AuditValueResolver,
  ctx: AuditValueResolverContext,
): string | undefined {
  return normalizeString(resolveAuditValue(resolver, ctx))
}

export function resolveAuditTargetId(
  options: AuditOptions,
  ctx: AuditValueResolverContext,
): string | undefined {
  return options.targetIdFrom ? normalizeString(resolveAuditValue(options.targetIdFrom, ctx)) : undefined
}

export function resolveAuditRouteTemplate(req: AppRequest): string | undefined {
  const routeUrl = normalizeString((req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url)
  if (routeUrl) return routeUrl
  return normalizeString((req as unknown as { routerPath?: string }).routerPath)
}

export function resolveAuditHttpStatus(reply: FastifyReply, error?: unknown): number {
  if (error instanceof HttpException) {
    return error.getStatus()
  }
  const statusCode = Number(reply.statusCode || 0)
  return statusCode > 0 ? statusCode : 200
}

export function resolveAuditErrorCode(error: unknown, responseBody?: unknown): string | undefined {
  if (error instanceof HttpException) {
    const response = error.getResponse()
    if (typeof response === 'object' && response && typeof (response as { code?: unknown }).code === 'string') {
      return String((response as { code: string }).code)
    }
    return normalizeString(typeof response === 'string' ? response : undefined)
  }
  if (isEnvelope(responseBody) && responseBody.ok === false) {
    return normalizeString(responseBody.code)
  }
  return undefined
}

export function resolveAuditStatus(
  options: AuditOptions,
  ctx: AuditValueResolverContext,
  httpStatus: number,
): 'success' | 'failure' {
  if (ctx.error) return 'failure'
  if (isEnvelope(ctx.responseBody) && ctx.responseBody.ok === false) return 'failure'
  if (httpStatus >= 400) return 'failure'
  if (options.successEvaluator && !options.successEvaluator(ctx)) return 'failure'
  return 'success'
}

export function resolveAuditValue(resolver: AuditValueResolver, ctx: AuditValueResolverContext): string | null | undefined {
  if (typeof resolver === 'function') return resolver(ctx)
  if (!looksLikeAuditPath(resolver)) return resolver
  return resolvePathValue(resolver, ctx)
}

function resolvePathValue(path: string, ctx: AuditValueResolverContext): string | null | undefined {
  const segments = String(path || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0) return undefined

  const [root, ...rest] = segments
  let current: unknown
  switch (root) {
    case 'params':
      current = ctx.req.params
      break
    case 'query':
      current = ctx.req.query
      break
    case 'body':
      current = ctx.req.body
      break
    case 'ctx':
      current = ctx.req.ctx
      break
    case 'response':
      current = ctx.responseBody
      break
    default:
      current = undefined
      break
  }

  for (const segment of rest) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  if (current === null || current === undefined) return undefined
  return typeof current === 'string' ? current : String(current)
}

function looksLikeAuditPath(value: string): boolean {
  return /^(params|query|body|ctx|response)\./.test(String(value || '').trim())
}

function normalizeString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  return text || undefined
}

function isEnvelope(value: unknown): value is { ok: boolean; code?: string } {
  return typeof value === 'object' && value !== null && 'ok' in value
}
