import { SetMetadata } from '@nestjs/common'
import { AUDIT_METADATA_KEY } from './audit.constants.js'
import type { AuditOptions } from './audit.types.js'

export const Audit = (options: AuditOptions) => SetMetadata(AUDIT_METADATA_KEY, options)
