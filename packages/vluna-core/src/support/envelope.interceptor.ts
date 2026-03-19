import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, map } from 'rxjs'
import type { FastifyReply } from 'fastify'
import type { Envelope } from '../common/envelope.js'

function isEnvelope(val: unknown): val is Envelope<unknown> {
  return !!val && typeof val === 'object' && 'ok' in (val as Record<string, unknown>) && 'code' in (val as Record<string, unknown>)
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<FastifyReply>()
    return next.handle().pipe(
      map((val) => {
        // If controller already returned an envelope, keep it
        if (isEnvelope(val)) {
          try {
            if (!val.ok) {
              const http = mapErrorCodeToHttp(val.code)
              res.status(http)
            }
            // For ok=true, respect any status set earlier; Fastify defaults to 200.
          } catch {}
          return val
        }
        // Wrap non-envelope output
        const out = { ok: true, code: 'OK', data: val }
        // Default success status is 200
        try { res.status(200) } catch {}
        return out
      }),
    )
  }
}

function mapErrorCodeToHttp(code: unknown): number {
  const c = String(code || '').toUpperCase()
  switch (c) {
    case 'AUTH.UNAUTHORIZED':
    case 'AUTH.TOKEN_EXPIRED':
      return 401
    case 'AUTH.INSUFFICIENT_SCOPE':
      return 403
    case 'RESOURCE.NOT_FOUND':
      return 404
    case 'VALIDATION.FIELD_REQUIRED':
    case 'VALIDATION.INVALID_INPUT':
    case 'WRITE.INVALID_PAYLOAD':
      return 422
    case 'SERVER.UPSTREAM':
      return 502
    case 'SERVER.CONFIG':
      return 500
    case 'SERVER.UNEXPECTED':
    default:
      return 500
  }
}
