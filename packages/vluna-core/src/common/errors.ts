export class AuthError extends Error {
  code: string
  constructor(code = 'AUTH.UNAUTHORIZED', message = 'Unauthorized.') {
    super(message)
    this.code = code
  }
}

