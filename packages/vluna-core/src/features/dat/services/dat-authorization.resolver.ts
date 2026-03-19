import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  DAT_AUTHORIZATION_POLICY_OVERRIDE,
  type DatAuthorizationPolicy,
  type DatSessionGrant,
  type IssueDatSessionFromBearerParams,
  type IssueDatSessionParams,
} from '../../../auth/policies/dat-authorization.policy.js'
import { OssDatAuthorizationPolicy } from '../policies/oss-dat-authorization.policy.js'

@Injectable()
export class DatAuthorizationResolver implements DatAuthorizationPolicy {
  constructor(
    @Inject(OssDatAuthorizationPolicy) private readonly fallback: OssDatAuthorizationPolicy,
    @Optional() @Inject(DAT_AUTHORIZATION_POLICY_OVERRIDE) private readonly override?: DatAuthorizationPolicy,
  ) {}

  issueSession(params: IssueDatSessionParams): Promise<DatSessionGrant> {
    if (this.override?.issueSession) {
      return this.override.issueSession(params)
    }
    return this.fallback.issueSession(params)
  }

  issueSessionFromBearer(params: IssueDatSessionFromBearerParams): Promise<DatSessionGrant> {
    if (this.override?.issueSessionFromBearer) {
      return this.override.issueSessionFromBearer(params)
    }
    if (this.fallback.issueSessionFromBearer) {
      return this.fallback.issueSessionFromBearer(params)
    }
    throw new Error('dat_bearer_exchange_not_supported')
  }
}
