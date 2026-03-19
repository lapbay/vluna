import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Optional } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'
import { REALM_ACCESS_POLICY, type RealmAccessPolicy } from '../policies/realm-access.policy.js'

@Injectable()
export class RealmMembershipGuard implements CanActivate {
  constructor(@Optional() @Inject(REALM_ACCESS_POLICY) private readonly realmAccessPolicy?: RealmAccessPolicy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    req.ctx = req.ctx || {}

    const scheme = req.ctx.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme === 'service') {
      return true
    }
    if (scheme && scheme !== 'bearer') {
      return true
    }

    const realmIdFromPath = String((req as unknown as { params?: Record<string, unknown> })?.params?.realmId || '').trim()
    const realmId = realmIdFromPath || String(req?.ctx?.realmId || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'realm_id missing' }, 403)
    }
    req.ctx.realmId = realmId

    if (this.realmAccessPolicy) {
      const allowed = await this.realmAccessPolicy.allowBearerRealmAccess(req, realmId)
      if (!allowed) {
        throw new HttpException({ code: 'AUTH.INSUFFICIENT_SCOPE', message: 'realm access denied' }, 403)
      }
    }
    return true
  }
}
