import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// @Global — AuditService доступен в tokens/oauth/webhooks без явного импорта.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
