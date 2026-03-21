import { Global, Module } from '@nestjs/common'
import { AuditInterceptor } from './audit/audit.interceptor.js'
import { AuditWriter } from './audit/audit.writer.js'

@Global()
@Module({
  providers: [AuditWriter, AuditInterceptor],
  exports: [AuditWriter, AuditInterceptor],
})
export class AuditModule {}
