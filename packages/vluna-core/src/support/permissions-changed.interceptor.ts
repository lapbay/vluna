import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../types/app-request.js'

// Sets X-Permissions-Changed=1 when a token version differs from the user's stored version.
// Upstream guards/middleware should populate req.versionToken and req.versionUser if available.

@Injectable()
export class PermissionsChangedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp()
    const req = ctx.getRequest<AppRequest>()
    const res = ctx.getResponse<FastifyReply>()
    return next.handle().pipe(
      tap(() => {
        const vt = req.ctx?.versionToken
        const vu = req.ctx?.versionUser
        if (vt && vu && vt !== vu) {
          res.header('X-Permissions-Changed', '1')
        }
      })
    )
  }
}
