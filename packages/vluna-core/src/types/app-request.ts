import type { FastifyRequest } from 'fastify'
import type { RequestContext } from './request-context.js'

// Shared request type across the app. All custom state must live in `ctx`.
export type AppRequest = FastifyRequest & { ctx: RequestContext }

