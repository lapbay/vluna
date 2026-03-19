export class DomainError extends Error {
  code: string
  status: number
  details?: Record<string, unknown>

  constructor(code: string, message: string, status = 422, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}
