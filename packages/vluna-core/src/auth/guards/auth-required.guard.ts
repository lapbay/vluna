import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'

@Injectable()
export class AuthRequiredGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const authorization = req.headers?.authorization
    const scheme = detectAuthScheme(authorization)
    if (!scheme) {
      throw new HttpException('unsupported_authorization_scheme', 401)
    }
    req.ctx = req.ctx || {}
    req.ctx.authScheme = scheme
    return true
  }
}
