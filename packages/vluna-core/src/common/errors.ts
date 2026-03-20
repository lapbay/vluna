import { HttpException } from '@nestjs/common'

export class AuthError extends Error {
  code: string
  constructor(code = 'AUTH.UNAUTHORIZED', message = 'Unauthorized.') {
    super(message)
    this.code = code
  }
}

export function unknownRealmHttpException(realmId?: string): HttpException {
  return new HttpException(
    {
      code: 'AUTH.UNKNOWN_REALM',
      message: 'unknown_realm',
      meta: {
        clear_cached_realm: true,
        realm_id: typeof realmId === 'string' && realmId.trim() ? realmId.trim() : undefined,
      },
    },
    404,
  )
}
