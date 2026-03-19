import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'

@Injectable()
export class RequireServiceAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const scheme = req?.ctx?.authScheme
    const allowed = scheme === 'service' || req?.ctx?.serviceAccessAllowed
    if (!allowed) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'service authentication required' }, 403)
    }
    return true
  }
}
