import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import { newSpanId } from './trace.util.js'
import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../types/app-request.js'

@Injectable()
export class TraceHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp()
    const req = ctx.getRequest<AppRequest>()
    const res = ctx.getResponse<FastifyReply>()
    const traceId = req.ctx?.traceId
    return next.handle().pipe(
      tap(() => {
        if (traceId) {
          const span = newSpanId()
          res.header('traceparent', `00-${traceId}-${span}-01`)
          res.header('x-request-id', traceId)
        }
      }),
    )
  }
}
