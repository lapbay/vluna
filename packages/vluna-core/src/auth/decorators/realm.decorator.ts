import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'

export const Realm = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AppRequest>()
  return (req && (req.ctx?.realmId || (req.headers?.['x-realm-id'] as string | undefined))) || null
})
