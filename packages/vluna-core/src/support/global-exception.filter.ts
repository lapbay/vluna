import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../types/app-request.js'
import { defaultMessageFor } from '../contracts/error-codes.js'
import type { components as GateComponents } from '../contracts/gate.js'

type GateHint = GateComponents['schemas']['Hint']

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<FastifyReply>()
    const req = ctx.getRequest<AppRequest>()
    const traceId = req.ctx?.traceId
    const method = (req as unknown as { method?: string })?.method || 'UNKNOWN'
    const path = (req as unknown as { url?: string; originalUrl?: string })?.originalUrl
      || (req as unknown as { url?: string })?.url
      || 'unknown'

    // Map known HTTP exceptions to envelope + semantic HTTP status
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest HttpException body: accept loosely here
      const resp = exception.getResponse() as any
      const code = pickCodeFromStatusOrResponse(status, resp)
      const message = typeof resp === 'string' ? resp : (resp?.message ?? defaultMessageFor(code) ?? 'Error')
      const hints = Array.isArray(resp?.hints) ? resp.hints : undefined
      const metaFromResp = isRecord(resp?.meta) ? resp.meta : undefined
      const mergedMeta = metaFromResp
        ? { ...metaFromResp, status }
        : { status }
      const payload: {
        ok: false
        code: string
        message: string
        meta?: Record<string, unknown>
        hints?: GateHint[]
        traceId?: string
      } = {
        ok: false,
        code,
        message,
        traceId,
      }
      if (mergedMeta && Object.keys(mergedMeta).length > 0) {
        payload.meta = mergedMeta
      }
      if (hints && hints.length > 0) {
        payload.hints = hints
      }
      if (status >= 500) {
        const cause = exception.cause
        const stack =
          cause instanceof Error
            ? (cause.stack || cause.message)
            : exception.stack
        this.logger.error(
          `http_exception_5xx method=${method} path=${path} status=${status} traceId=${traceId || 'none'} code=${code}`,
          stack,
        )
      }
      res.status(status).send(payload)
      return
    }
    // Fallback
    const stack = exception instanceof Error ? (exception.stack || exception.message) : String(exception)
    this.logger.error(
      `unhandled_exception method=${method} path=${path} status=500 traceId=${traceId || 'none'}`,
      stack,
    )
    res.status(500).send({ ok: false, code: 'SERVER.UNEXPECTED', message: defaultMessageFor('SERVER.UNEXPECTED') || 'Unexpected error', traceId })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest resp: accept loosely here
function pickCodeFromStatusOrResponse(status: number, resp: any): string {
  if (resp && typeof resp === 'object' && typeof resp.code === 'string') return resp.code
  switch (status) {
    case 400: return 'VALIDATION.INVALID_INPUT'
    case 401: return 'AUTH.UNAUTHORIZED'
    case 403: return 'AUTH.INSUFFICIENT_SCOPE'
    case 404: return 'RESOURCE.NOT_FOUND'
    case 409: return 'WRITE.INVALID_PAYLOAD' // closest fit without a specific conflict code
    case 422: return 'VALIDATION.INVALID_INPUT'
    case 502: return 'SERVER.UPSTREAM'
    default: return 'SERVER.UNEXPECTED'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
