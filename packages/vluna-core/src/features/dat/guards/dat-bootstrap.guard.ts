import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../../types/app-request.js'
import { DatBootstrapService } from '../services/dat-bootstrap.service.js'

@Injectable()
export class DatBootstrapGuard implements CanActivate {
  constructor(private readonly bootstrapService: DatBootstrapService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const rawAuth = Array.isArray(req.headers?.authorization) ? req.headers.authorization[0] : req.headers?.authorization
    if (!rawAuth || typeof rawAuth !== 'string' || !rawAuth.toLowerCase().startsWith('bearer ')) {
      throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'Bearer bootstrap token required' }, 401)
    }
    const token = rawAuth.slice(7).trim()
    if (!token) {
      throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'Bearer bootstrap token required' }, 401)
    }
    const principal = await this.bootstrapService.verifyBootstrapToken(token)
    req.ctx = req.ctx || {}
    req.ctx.datBootstrap = principal
    return true
  }
}
