import { CanActivate, ExecutionContext, Injectable, HttpException, Inject } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { RealmConfigService } from '../../security/realm-config.service.js'

@Injectable()
export class RealmGuard implements CanActivate {
  constructor(@Inject(RealmConfigService) private readonly realmConfig: RealmConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const realm = (req.headers?.['x-realm-id'] as string | undefined)?.trim()
    if (!realm) throw new HttpException('missing_realm', 400)
    req.ctx = req.ctx || {}
    req.ctx.realmId = realm
    try {
      const status = await this.realmConfig.getRealmStatus(realm)
      if (status === 'deleted') {
        throw new HttpException('unknown_realm', 404)
      }
      if (status !== 'active') {
        throw new HttpException('realm_inactive', 403)
      }
      const authProfile = await this.realmConfig.getAuthProfile(realm)
      // Attach a sanitized realm config snapshot (no secrets) for downstream use.
      const paymentProviderId = (await this.realmConfig.getPaymentProvider(realm)).providerId || 'unknown'
      const billingDefaultsPeriod = await this.realmConfig.getBillingDefaultsPeriod(realm)
      const realmAccessAllowlist = await this.realmConfig.getRealmAccessAllowlist(realm)
      req.ctx.realmConfig = {
        realmId: realm,
        paymentProvider: paymentProviderId,
        auth: authProfile,
        billingDefaultsPeriod,
        realmAccessAllowlist,
      }
      // Back-compat until callers switch to realmConfig.auth
    } catch (err) {
      if ((err as { code?: string }).code === 'realm_not_found') {
        throw new HttpException('unknown_realm', 404)
      }
      throw err
    }
    return true
  }
}
