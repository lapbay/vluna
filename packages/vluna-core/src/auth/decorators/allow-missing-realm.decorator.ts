import { SetMetadata } from '@nestjs/common'

export const ALLOW_MISSING_REALM_KEY = 'allow_missing_realm'
export const AllowMissingRealm = () => SetMetadata(ALLOW_MISSING_REALM_KEY, true)
