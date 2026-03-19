import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, from } from 'rxjs'
import { firstValueFrom } from 'rxjs'
import crypto from 'node:crypto'
import type { AppRequest } from '../types/app-request.js'
import type { Envelope } from '../common/envelope.js'
import { cache } from '../utils/cache.js'

type CacheEntry = { bodyHash: string; response: unknown }

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static TTL_SECONDS = 24 * 60 * 60 // 24h

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.process(context, next))
  }

  private async process(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const method = String(req?.method || 'POST').toUpperCase()
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return await firstValueFrom(next.handle())
    }
    const idk = String(req?.headers?.['idempotency-key'] || req?.headers?.['Idempotency-Key'] || '').trim()
    if (!idk) throw new HttpException('missing_idempotency_key', 400)
    req.ctx = req.ctx || {}
    req.ctx.idempotencyKey = idk

    const url: string = String(req?.url || '')
    const sub: string = String(req.ctx?.sub || '')
    const pathOnly = url.split('?')[0]
    const cacheKey = `idempotency:${method}:${pathOnly}:${sub}:${idk}`
    const bodyStr = JSON.stringify(req?.body ?? null)
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex')

    const hit = await cache.get<CacheEntry>(cacheKey)
    if (hit) {
      if (hit.bodyHash !== bodyHash) throw new HttpException('idempotency_conflict', 409)
      return hit.response
    }

    const resp = await firstValueFrom(next.handle())
    try {
      const ok = typeof resp === 'object' && resp !== null && 'ok' in (resp as Record<string, unknown>) ? Boolean((resp as Envelope).ok) : false
      // Treat responses with meta.ok set to false as upstream failures; meta is untyped external payload
      const meta = (resp as Envelope | undefined)?.meta
      const metaOk = (meta as Record<string, unknown> | undefined)?.ok
      const upstreamOk = metaOk !== false
      if (ok && upstreamOk) {
        const entry: CacheEntry = { bodyHash, response: resp }
        await cache.setex(cacheKey, IdempotencyInterceptor.TTL_SECONDS, entry)
      }
    } catch {}
    return resp
  }
}
