import { SetMetadata, createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'

export const REQUIRED_SCOPES_KEY = 'required_scopes'
export const Scopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes)

export const Claims = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>()
  return (req && req.ctx?.claims) || null
})
