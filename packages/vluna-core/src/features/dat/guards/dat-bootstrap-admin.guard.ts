import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../../types/app-request.js'

@Injectable()
export class DatBootstrapAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const allowed = req?.ctx?.authScheme === 'service' || req?.ctx?.serviceAccessAllowed === true
    if (!allowed) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'service authentication required' }, 403)
    }
    const realmId = String(req?.ctx?.realmId || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id required' }, 400)
    }
    return true
  }
}

