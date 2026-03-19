import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { FastifyReply } from 'fastify'

// Ensure auth/trace headers are readable by browsers.
// Mirrors FastAPI expose-headers middleware.
const BASE_HEADERS = new Set(['traceparent', 'X-Permissions-Changed', 'WWW-Authenticate'])

@Injectable()
export class ExposeHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp()
    const res = ctx.getResponse<FastifyReply>()
    return next.handle().pipe(
      tap(() => {
        // Optionally include X-Request-Id (vluna currently always sets it)
        const required = new Set(BASE_HEADERS)
        required.add('X-Request-Id')

        const existing = String(res.getHeader('access-control-expose-headers') || '')
        if (existing) {
          const current = new Set(existing.split(',').map((s) => s.trim()).filter(Boolean))
          for (const h of required) current.add(h)
          res.header('Access-Control-Expose-Headers', Array.from(current).sort().join(', '))
        } else {
          res.header('Access-Control-Expose-Headers', Array.from(required).sort().join(', '))
        }
      }),
    )
  }
}
