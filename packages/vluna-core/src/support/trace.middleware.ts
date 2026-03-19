import { Injectable, NestMiddleware } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { parseIncomingTrace } from './trace.util.js'
import type { AppRequest } from '../types/app-request.js'
import { IS_ADMIN_PLANE, PLANE } from '../config/plane.js'

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: FastifyRequest, _res: FastifyReply, next: () => void) {
    const fReq = req as AppRequest
    const traceparent = (fReq.headers?.['traceparent'] as string | undefined)
    const xrid = (fReq.headers?.['x-request-id'] as string | undefined)
    const traceId = parseIncomingTrace(traceparent, xrid)
    fReq.ctx = fReq.ctx || {}
    fReq.ctx.traceId = traceId
    fReq.ctx.plane = PLANE
    fReq.ctx.isAdminPlane = IS_ADMIN_PLANE
    // Headers are written by TraceHeadersInterceptor before the response is sent.
    next()
  }
}
