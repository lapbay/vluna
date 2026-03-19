import type { RealmAuthProfile } from '../../security/realm-config.service.js'
import type { JWTPayload, JWSHeaderParameters } from 'jose'

export interface TokenClaims {
  sub?: string
  iss?: string
  aud?: string | string[]
  exp?: number
  iat?: number
  scope?: string | string[]
  roles?: string[]
  permissions?: string[]
  organization_id?: string
  client_id?: string
  v?: string
  [key: string]: unknown
}

export interface TokenVerifyOptions {
  realmId?: string
  authProfile?: RealmAuthProfile | null
  audience?: string
}

export interface TokenValidator {
  verify(token: string, options?: TokenVerifyOptions): Promise<TokenClaims>
}

export interface TokenDescriptor {
  raw: string
  header: JWSHeaderParameters | null
  payload: JWTPayload | null
}

export interface TokenValidationStrategy {
  readonly name: string
  supports(descriptor: TokenDescriptor, options?: TokenVerifyOptions): boolean | Promise<boolean>
  verify(descriptor: TokenDescriptor, options?: TokenVerifyOptions): Promise<TokenClaims>
}

export const TOKEN_VALIDATOR = Symbol('TOKEN_VALIDATOR')
