import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common'
import {
  REQUIRED_AUDIENCE_KEY,
  REALM_DEFAULT_AUDIENCE,
} from '../../../auth/decorators/audience.decorator.js'
import type { AppRequest } from '../../../types/app-request.js'
import { DatBootstrapService } from '../services/dat-bootstrap.service.js'
import { TOKEN_VALIDATOR, type TokenValidator } from '../../../auth/tokens/token.types.js'
import { Reflector } from '@nestjs/core'
import type { RealmAuthProfile } from '../../../security/realm-config.service.js'

@Injectable()
export class DatSessionIssueAuthGuard implements CanActivate {
  constructor(
    private readonly bootstrapService: DatBootstrapService,
    @Inject(TOKEN_VALIDATOR) private readonly validator: TokenValidator,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const auth = Array.isArray(req.headers?.authorization) ? req.headers.authorization[0] : req.headers?.authorization
    if (!auth || typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
      throw new HttpException('missing_token', 401)
    }
    const token = auth.slice(7).trim()
    if (!token) throw new HttpException('missing_token', 401)

    if (isBootstrapToken(token)) {
      const bootstrap = await this.bootstrapService.verifyBootstrapToken(token)
      req.ctx = req.ctx || {}
      req.ctx.datBootstrap = bootstrap
      req.ctx.datAuthMode = 'bootstrap'
      return true
    }

    const audienceMeta = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_AUDIENCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    const realmId = req.ctx?.realmId || (req.headers?.['x-realm-id'] as string | undefined)?.trim()
    let claims
    try {
      claims = await this.validator.verify(token, {
        realmId,
        authProfile: req.ctx?.realmConfig?.auth as RealmAuthProfile | null | undefined,
        audience: resolveAudience(audienceMeta, req.ctx?.realmConfig?.auth),
      })
    } catch {
      throw new HttpException('invalid_token', 401)
    }

    req.ctx = req.ctx || {}
    req.ctx.claims = claims
    req.ctx.claimsVerified = true
    const sub = typeof claims.sub === 'string' ? claims.sub : ''
    if (sub) {
      req.ctx.sub = sub
      req.ctx.userId = sub
    }
    req.ctx.datAuthMode = 'oauth'
    return true
  }
}

function isBootstrapToken(token: string): boolean {
  const normalized = String(token || '').trim()
  return normalized.startsWith('datb_') || /^\d+:datb_[A-Za-z0-9._-]+$/.test(normalized)
}

function resolveAudience(
  metaAudience: string | undefined,
  profile: RealmAuthProfile | null | undefined,
): string | undefined {
  if (!metaAudience || metaAudience === REALM_DEFAULT_AUDIENCE) {
    return profile?.issuers?.[0]?.audiences?.[0]
  }
  return metaAudience
}
