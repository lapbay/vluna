import type { RequestContext } from './request-context.js'

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: RequestContext
  }
}

