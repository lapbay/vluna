// GENERATED FILE. Do not edit.
// version: 1.0.0
export type ErrorCode = 'OK' | 'AUTH.UNAUTHORIZED' | 'AUTH.INSUFFICIENT_SCOPE' | 'AUTH.TOKEN_EXPIRED' | 'AUTH.UNKNOWN_REALM' | 'VALIDATION.FIELD_REQUIRED' | 'RESOURCE.NOT_FOUND' | 'WRITE.DEFERRED' | 'WRITE.INVALID_PAYLOAD' | 'SERVER.UNEXPECTED' | 'SERVER.UPSTREAM' | 'SERVER.CONFIG' | 'VALIDATION.INVALID_INPUT';
export type ErrorCodeMeta = { http?: number; retry?: 'never' | 'safe' | 'after'; default_message?: string; i18n_key?: string };
export const ERROR_CATALOG = {
  "OK": {
    "http": 200
  },
  "AUTH.UNAUTHORIZED": {
    "http": 200,
    "retry": "never",
    "default_message": "Unauthorized."
  },
  "AUTH.INSUFFICIENT_SCOPE": {
    "http": 200,
    "retry": "never",
    "default_message": "insufficient_scope"
  },
  "AUTH.TOKEN_EXPIRED": {
    "http": 200,
    "retry": "safe",
    "default_message": "The session has expired. Please sign in again.",
    "i18n_key": "errors.auth.tokenExpired"
  },
  "AUTH.UNKNOWN_REALM": {
    "http": 200,
    "retry": "never",
    "default_message": "The selected realm is no longer available."
  },
  "VALIDATION.FIELD_REQUIRED": {
    "http": 200,
    "retry": "never",
    "default_message": "A required field is missing."
  },
  "RESOURCE.NOT_FOUND": {
    "http": 200,
    "retry": "never",
    "default_message": "Resource not found."
  },
  "WRITE.DEFERRED": {
    "http": 200,
    "retry": "after",
    "default_message": "Accepted but not persisted.",
    "i18n_key": "errors.write.deferred"
  },
  "WRITE.INVALID_PAYLOAD": {
    "http": 200,
    "retry": "never",
    "default_message": "Invalid input for write operation.",
    "i18n_key": "errors.write.invalidPayload"
  },
  "SERVER.UNEXPECTED": {
    "http": 200,
    "retry": "after",
    "default_message": "Unexpected server error. Please try again later."
  },
  "SERVER.UPSTREAM": {
    "http": 200,
    "retry": "after",
    "default_message": "Upstream service error."
  },
  "SERVER.CONFIG": {
    "http": 200,
    "retry": "never",
    "default_message": "Server configuration error."
  },
  "VALIDATION.INVALID_INPUT": {
    "http": 200,
    "retry": "never",
    "default_message": "Invalid input."
  }
} as const;
export function getErrorCodeMeta(code: string): ErrorCodeMeta {
  const catalog = ERROR_CATALOG as unknown as Record<string, ErrorCodeMeta>
  return catalog[code] ?? { http: 200 }
}
export function knownErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)
}
export function defaultMessageFor(code: string): string | undefined {
  return getErrorCodeMeta(code).default_message
}