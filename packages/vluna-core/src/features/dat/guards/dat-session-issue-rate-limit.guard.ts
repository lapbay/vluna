import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../../types/app-request.js'

type RateState = {
  count: number
  resetAt: number
}

@Injectable()
export class DatSessionIssueRateLimitGuard implements CanActivate {
  private static readonly hits = new Map<string, RateState>()
  private static readonly windowMs = Number(process.env.VLUNA_DAT_SESSION_ISSUE_RATELIMIT_WINDOW_MS || 60_000)
  private static readonly limit = Number(process.env.VLUNA_DAT_SESSION_ISSUE_RATELIMIT_LIMIT || 60)

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const subject = String(req.ctx?.datBootstrap?.subject_id || req.ctx?.sub || 'unknown').trim()
    const organizationId = String(
      req.ctx?.datBootstrap?.organization_id ||
      (typeof req.ctx?.claims?.organization_id === 'string' ? req.ctx?.claims?.organization_id : '') ||
      '',
    ).trim()
    const ip = getClientIp(req)
    const now = Date.now()
    const key = `${subject}:${organizationId || '-'}:${ip}`
    const current = DatSessionIssueRateLimitGuard.hits.get(key)
    if (!current || current.resetAt <= now) {
      DatSessionIssueRateLimitGuard.hits.set(key, { count: 1, resetAt: now + DatSessionIssueRateLimitGuard.windowMs })
      return true
    }
    if (current.count >= DatSessionIssueRateLimitGuard.limit) {
      throw new HttpException({ code: 'AUTH.RATE_LIMITED', message: 'too many dat session issue requests' }, 429)
    }
    current.count += 1
    return true
  }
}

function getClientIp(req: AppRequest): string {
  const forwarded = req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = String(forwarded[0] || '').split(',')[0]?.trim()
    if (first) return first
  }
  const ip = (req as unknown as { ip?: string }).ip
  if (typeof ip === 'string' && ip.trim()) return ip.trim()
  const remoteAddress = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  if (typeof remoteAddress === 'string' && remoteAddress.trim()) return remoteAddress.trim()
  return 'unknown'
}
