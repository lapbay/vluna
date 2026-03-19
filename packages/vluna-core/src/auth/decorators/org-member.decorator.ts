import { SetMetadata } from '@nestjs/common'

export const ORG_PARAM_KEY = 'org_param_key'
export const OrgMember = (paramName: string = 'orgId') => SetMetadata(ORG_PARAM_KEY, paramName)

