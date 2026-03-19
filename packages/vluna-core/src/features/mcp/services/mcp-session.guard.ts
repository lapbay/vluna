import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../../types/app-request.js'
import { McpSessionTokenService } from './mcp-session-token.service.js'

@Injectable()
export class McpSessionGuard implements CanActivate {
  constructor(private readonly tokenService: McpSessionTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const raw = Array.isArray(req.headers?.authorization) ? req.headers.authorization[0] : req.headers?.authorization
    if (!raw || typeof raw !== 'string' || !raw.toLowerCase().startsWith('bearer ')) {
      throw new HttpException({ code: 'AUTH.MISSING_TOKEN', message: 'Bearer mcp session token required' }, 401)
    }
    const token = raw.slice(7).trim()
    if (!token) {
      throw new HttpException({ code: 'AUTH.MISSING_TOKEN', message: 'Bearer mcp session token required' }, 401)
    }
    try {
      const claims = await this.tokenService.verify(token)
      req.ctx = req.ctx || {}
      req.ctx.mcpSession = claims
      if (claims.selected_realm) {
        req.ctx.realmId = claims.selected_realm
      }
      return true
    } catch (error) {
      throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: (error as Error)?.message || 'invalid mcp token' }, 401)
    }
  }
}
