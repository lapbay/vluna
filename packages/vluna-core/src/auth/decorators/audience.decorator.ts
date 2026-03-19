import { SetMetadata } from '@nestjs/common'

export const REQUIRED_AUDIENCE_KEY = 'required_audience'
export const REALM_DEFAULT_AUDIENCE = '__realm_default__'
export const Audience = (aud?: string) => SetMetadata(REQUIRED_AUDIENCE_KEY, aud ?? REALM_DEFAULT_AUDIENCE)
